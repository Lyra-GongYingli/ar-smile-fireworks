// Pinned uncompressed size and SHA-256 of every file that may come from a
// mirror (see src/download.js). Bytes that do not match are never used.
// src/download.js keeps its own copy of the sizes and paths (it is a classic
// script and cannot import); tests/download.test.js checks the two agree.
export const ASSETS = {
  wasm: {
    path: 'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
    size: 14603354,
    sha256: 'f5bd25147ac89d506074293ce2675969b10e827180db95a0d9689c2ed80764ab',
  },
  loader: {
    path: 'vendor/mediapipe/wasm/vision_wasm_internal.js',
    size: 334128,
    sha256: 'f2b9c17131ea79716ec6bf07b117a087b2749a6f8a1e2f1f2e77a9382092db5b',
  },
  model: {
    path: 'models/face_landmarker.task',
    size: 3758596,
    sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
  },
};
