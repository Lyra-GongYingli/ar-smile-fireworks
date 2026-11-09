// MediaPipe FaceLandmarker wrapper: loading with progress, GPU->CPU fallback,
// and a scheduler that infers at most once per *new* camera frame and keeps
// inference under a share of main-thread time.

import { FaceLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';
import { ASSETS } from './assets.js';

const ROOT = new URL('../', import.meta.url);
const WASM_LOADER = new URL('vendor/mediapipe/wasm/vision_wasm_internal.js', ROOT).href;
const WASM_BINARY = new URL('vendor/mediapipe/wasm/vision_wasm_internal.wasm', ROOT).href;
const MODEL = new URL('models/face_landmarker.task', ROOT).href;

// Own-host URL of each pinned asset: the fallback when a mirror's bytes fail the check.
const SELF = {
  wasm: WASM_BINARY,
  loader: WASM_LOADER,
  model: MODEL,
};

async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let h = '';
  for (const b of d) h += b.toString(16).padStart(2, '0');
  return h;
}

/**
 * Wait for the downloads src/download.js started from the page, report
 * combined progress 0..1, and verify every file. A file from a mirror that
 * fails the check is fetched again from the page's own host.
 */
export async function preloadAssets(onProgress) {
  let dl = window.__downloads;
  if (!dl && window.__createDownloads) dl = window.__createDownloads(fetch.bind(window), () => Date.now()).start();
  if (!dl) throw new Error('downloader script missing');
  dl.onProgress = () => {
    const got = dl.got.wasm + dl.got.loader + dl.got.model;
    onProgress(Math.min(0.99, got / dl.total), dl.retries);
  };
  dl.onProgress();

  const out = { sources: {} };
  await Promise.all(
    Object.keys(ASSETS).map(async (key) => {
      let r = await dl.promises[key];
      if ((await sha256Hex(r.bytes)) !== ASSETS[key].sha256) {
        console.warn(`${key}: checksum mismatch from ${r.url}, refetching from own host`);
        r = await dl.fetch(key, [SELF[key]]);
        if ((await sha256Hex(r.bytes)) !== ASSETS[key].sha256) throw new Error(`${key}: checksum mismatch`);
      }
      out[key] = r.bytes;
      out.sources[key] = new URL(r.url, location.href).host;
    }),
  );
  onProgress(1, dl.retries);
  return out;
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
    // Verified bytes are handed to MediaPipe as blob URLs, so nothing is
    // downloaded twice and nothing unverified runs.
    const blobs = [];
    const asBlob = (bytes, type) => {
      const u = URL.createObjectURL(new Blob([bytes], { type }));
      blobs.push(u);
      return u;
    };
    const fileset = {
      wasmLoaderPath: assets && assets.loader ? asBlob(assets.loader, 'text/javascript') : WASM_LOADER,
      wasmBinaryPath: assets && assets.wasm ? asBlob(assets.wasm, 'application/wasm') : WASM_BINARY,
    };
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
    for (const u of blobs) URL.revokeObjectURL(u);
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
