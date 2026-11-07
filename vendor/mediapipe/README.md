# Vendored MediaPipe files

Copied unmodified from `@mediapipe/tasks-vision@1.2.2` (npm), licensed Apache-2.0 by Google:

- `vision_bundle.mjs`
- `wasm/vision_wasm_internal.js`
- `wasm/vision_wasm_internal.wasm`

The face model `../../models/face_landmarker.task` (float16, 3,758,596 bytes,
sha256 `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`) comes from
`https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task`,
also Apache-2.0.

They are served from the same origin as the page so the demo does not depend on
third-party CDNs (some are unreachable in some regions).

Note: 1.2.x ships only a SIMD build of the wasm (v128 appears in its function
signatures), so browsers without WebAssembly SIMD cannot run it. `index.html`
checks for this before downloading.
