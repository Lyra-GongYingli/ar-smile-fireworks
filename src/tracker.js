// MediaPipe FaceLandmarker wrapper: loading with progress, GPU->CPU fallback,
// and a scheduler that infers at most once per *new* camera frame and keeps
// inference under a share of main-thread time.

import { FaceLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

const ROOT = new URL('../', import.meta.url);
const WASM_LOADER = new URL('vendor/mediapipe/wasm/vision_wasm_internal.js', ROOT).href;
const WASM_BINARY = new URL('vendor/mediapipe/wasm/vision_wasm_internal.wasm', ROOT).href;
const MODEL = new URL('models/face_landmarker.task', ROOT).href;

// Uncompressed sizes of the vendored files. Used as the progress denominator
// because Content-Length is the *compressed* size when the host gzips.
const EXPECTED = { wasm: 14603354, model: 3758596 };

async function fetchBytes(url, expected, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (!res.body || !res.body.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onBytes(buf.length);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onBytes(Math.min(got, expected));
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Download wasm + model in parallel, reporting combined progress 0..1. */
export async function preloadAssets(onProgress) {
  const got = { wasm: 0, model: 0 };
  const total = EXPECTED.wasm + EXPECTED.model;
  const report = () => onProgress(Math.min(0.99, (got.wasm + got.model) / total));
  const [wasm, model] = await Promise.all([
    fetchBytes(WASM_BINARY, EXPECTED.wasm, (n) => ((got.wasm = n), report())),
    fetchBytes(MODEL, EXPECTED.model, (n) => ((got.model = n), report())),
  ]);
  onProgress(1);
  return { wasm, model };
}

export class FaceTracker {
  constructor(cfg) {
    this.cfg = cfg;
    this.landmarker = null;
    this.delegate = '';
    this.video = null;
    this.frameSeq = 0;
    this.lastSeq = -1;
    this.lastVideoTime = -1;
    this.lastRunAt = -1e9;
    this.lastTs = 0;
    this.lastFaceAt = -1e9;
    this.idle = false;
    this.minIntervalMs = 1000 / cfg.maxHz;
    this.inferMs = 0;
    this.runs = 0;
    this.failed = null;
  }

  /** Create the landmarker, GPU first, CPU if the GPU path fails. */
  async init(assets, preferCPU = false) {
    let binaryUrl = WASM_BINARY;
    if (assets && assets.wasm) {
      binaryUrl = URL.createObjectURL(new Blob([assets.wasm], { type: 'application/wasm' }));
    }
    const fileset = { wasmLoaderPath: WASM_LOADER, wasmBinaryPath: binaryUrl };
    const model = assets && assets.model;
    const order = preferCPU ? ['CPU'] : ['GPU', 'CPU'];
    let lastErr = null;
    for (const delegate of order) {
      try {
        const tInit = performance.now();
        const lm = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: model ? { modelAssetBuffer: model, delegate } : { modelAssetPath: MODEL, delegate },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: false,
        });
        const tWarm = performance.now();
        this.initMs = tWarm - tInit;
        const warmed = warmUp(lm, this);
        this.warmUpMs = performance.now() - tWarm;
        if (!warmed && delegate === 'GPU') {
          lm.close();
          throw new Error('GPU warm-up inference failed');
        }
        this.landmarker = lm;
        this.delegate = delegate;
        this.failed = null;
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`FaceLandmarker ${delegate} init failed`, e);
      }
    }
    if (binaryUrl !== WASM_BINARY) URL.revokeObjectURL(binaryUrl);
    if (!this.landmarker) throw lastErr || new Error('FaceLandmarker init failed');
  }

  attachVideo(video) {
    this.video = video;
    this.hasRVFC = typeof video.requestVideoFrameCallback === 'function';
    if (this.hasRVFC) {
      const tick = () => {
        this.frameSeq++;
        if (this.video === video) video.requestVideoFrameCallback(tick);
      };
      video.requestVideoFrameCallback(tick);
    }
  }

  /** Run inference if a new camera frame is waiting and the budget allows. */
  poll(nowMs) {
    const v = this.video;
    if (!this.landmarker || !v || v.readyState < 2 || v.videoWidth === 0) return null;
    const fresh = this.hasRVFC ? this.frameSeq !== this.lastSeq : v.currentTime !== this.lastVideoTime;
    if (!fresh) return null;
    const interval = this.idle ? 1000 / this.cfg.idleHz : this.minIntervalMs;
    if (nowMs - this.lastRunAt < interval * 0.85) return null;
    this.lastSeq = this.frameSeq;
    this.lastVideoTime = v.currentTime;
    const ts = Math.max(nowMs, this.lastTs + 1); // must be strictly increasing
    this.lastTs = ts;

    const t0 = performance.now();
    let res;
    try {
      res = this.landmarker.detectForVideo(v, ts);
    } catch (e) {
      this.failed = e;
      return null;
    }
    const ms = performance.now() - t0;
    this.runs++;
    this.lastMs = ms;
    if (this.runs <= 3) {
      // The first real frames compile shaders and allocate textures (~190 ms
      // measured). Letting them into the average throttled detection to 4 Hz
      // for ~5 s, so they only ever lower the estimate.
      this.inferMs = this.runs === 1 ? ms : Math.min(this.inferMs, ms);
    } else {
      // Falls fast, rises slowly: a GC pause or tab switch must not stall
      // tracking, but sustained thermal slowdown still raises the budget.
      this.inferMs += (ms - this.inferMs) * (ms < this.inferMs ? 0.3 : 0.05);
    }
    this.minIntervalMs = Math.min(
      1000 / this.cfg.minHz,
      Math.max(1000 / this.cfg.maxHz, this.inferMs / this.cfg.mainThreadShare),
    );
    this.lastRunAt = nowMs;

    if (res.faceLandmarks && res.faceLandmarks.length > 0) {
      this.lastFaceAt = nowMs;
      this.idle = false;
    } else if (nowMs - this.lastFaceAt > this.cfg.idleAfterMs) {
      this.idle = true;
    }
    return res;
  }

  close() {
    if (this.landmarker) this.landmarker.close();
    this.landmarker = null;
  }
}

// First GPU inference compiles shaders (hundreds of ms). Do it during loading,
// not on the first camera frame.
function warmUp(lm, tracker) {
  try {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    c.getContext('2d').fillRect(0, 0, 64, 64);
    tracker.lastTs = Math.max(tracker.lastTs + 1, performance.now());
    lm.detectForVideo(c, tracker.lastTs);
    return true;
  } catch (e) {
    console.warn('warm-up failed', e);
    return false;
  }
}
