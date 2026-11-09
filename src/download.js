// Downloads the face model, the wasm binary and its loader script, each from
// whichever source delivers first: the page's own host (GitHub Pages) or a
// mirror that is fast inside mainland China. tracker.js checks every file
// against a pinned SHA-256 before use, so a mirror can make loading faster but
// can never change what runs.
//
// A classic script at the end of <body>: it runs before the deferred app
// modules (downloads start ~1 round trip after the HTML) and never blocks the
// first paint. Exposes window.__downloads.
(function (global) {
  'use strict';

  // Keep in sync with ASSETS in tracker.js (a unit test checks).
  var ASSETS = {
    wasm: {
      size: 14603354,
      urls: [
        'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
        'https://registry.npmmirror.com/@mediapipe/tasks-vision/1.2.2/files/wasm/vision_wasm_internal.wasm',
      ],
    },
    loader: {
      size: 334128,
      urls: [
        'vendor/mediapipe/wasm/vision_wasm_internal.js',
        'https://registry.npmmirror.com/@mediapipe/tasks-vision/1.2.2/files/wasm/vision_wasm_internal.js',
      ],
    },
    model: {
      size: 3758596,
      urls: [
        'models/face_landmarker.task',
        'https://cdn.jsdelivr.net/gh/Lyra-GongYingli/ar-smile-fireworks@95c5d48/models/face_landmarker.task',
      ],
    },
  };
  var DEFAULTS = {
    winBytes: 128 * 1024, // the first source to deliver this much wins; the others are cancelled
    stallMs: 12000, // no new bytes for this long: abandon the attempt and race again
  };

  function concat(chunks, n) {
    var out = new Uint8Array(n);
    var o = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], o);
      o += chunks[i].length;
    }
    return out;
  }

  /** Resolve with {bytes, url} from the first source to pass opt.winBytes and finish. */
  function race(urls, onBytes, fetchImpl, now, opt) {
    return new Promise(function (resolve, reject) {
      var leader = -1;
      var settled = false;
      var failed = 0;
      var last = now();
      var ctrls = urls.map(function () {
        return new AbortController();
      });
      var got = urls.map(function () {
        return 0;
      });
      var watchdog = setInterval(function () {
        if (now() - last > opt.stallMs) finish(new Error('stalled'));
      }, Math.min(1000, opt.stallMs / 4));

      function finish(err, value) {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        ctrls.forEach(function (c, j) {
          if (err || j !== leader) c.abort();
        });
        if (err) reject(err);
        else resolve(value);
      }
      function crown(i) {
        leader = i;
        ctrls.forEach(function (c, j) {
          if (j !== i) c.abort();
        });
      }

      urls.forEach(function (url, i) {
        var chunks = [];
        fetchImpl(url, { signal: ctrls[i].signal })
          .then(function (res) {
            if (!res.ok || !res.body) throw new Error('HTTP ' + res.status + ' for ' + url);
            var reader = res.body.getReader();
            function pump() {
              return reader.read().then(function (r) {
                if (settled || (leader !== -1 && leader !== i)) return;
                if (r.done) {
                  if (leader === -1) crown(i);
                  finish(null, { bytes: concat(chunks, got[i]), url: url });
                  return;
                }
                chunks.push(r.value);
                got[i] += r.value.length;
                last = now();
                if (leader === -1 && got[i] >= opt.winBytes) crown(i);
                onBytes(leader === -1 ? Math.max.apply(null, got) : got[leader]);
                return pump();
              });
            }
            return pump();
          })
          .catch(function (e) {
            if (settled) return;
            if (leader === i) finish(e);
            else if (leader === -1 && ++failed === urls.length) finish(e);
          });
      });
    });
  }

  function create(fetchImpl, now, options) {
    var opt = Object.assign({}, DEFAULTS, options || {});
    var state = {
      assets: ASSETS,
      got: { wasm: 0, loader: 0, model: 0 },
      total: ASSETS.wasm.size + ASSETS.loader.size + ASSETS.model.size,
      retries: 0,
      onProgress: null, // set by the app once it has loaded
      promises: {},
      fetch: fetchAsset,
    };

    function report(key, n) {
      state.got[key] = Math.min(n, ASSETS[key].size);
      if (state.onProgress) state.onProgress();
    }

    /** One asset; on failure or stall, race all sources once more. */
    function fetchAsset(key, urls) {
      var list = urls || ASSETS[key].urls;
      var onBytes = function (n) {
        report(key, n);
      };
      return race(list, onBytes, fetchImpl, now, opt)
        .catch(function () {
          state.retries++;
          report(key, 0);
          return race(list, onBytes, fetchImpl, now, opt);
        })
        .then(function (r) {
          report(key, ASSETS[key].size);
          return r;
        });
    }

    state.start = function () {
      Object.keys(ASSETS).forEach(function (key) {
        state.promises[key] = fetchAsset(key);
      });
      return state;
    };
    return state;
  }

  global.__createDownloads = create;
  var caps = global.__caps;
  if (caps && caps.wasm && caps.simd && caps.gl && typeof global.fetch === 'function') {
    global.__downloads = create(global.fetch.bind(global), function () {
      return Date.now();
    }).start();
  }
})(typeof window !== 'undefined' ? window : globalThis);
