import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { ASSETS } from '../src/assets.js';

// download.js is a classic browser script: run it in a sandbox with a fake window.
function load() {
  const code = fs.readFileSync(new URL('../src/download.js', import.meta.url), 'utf8');
  const ctx = { window: {}, AbortController, setInterval, clearInterval, setTimeout, Uint8Array, Promise, Object, Math, Date, Error };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  assert.equal(ctx.window.__downloads, undefined, 'must not auto-start without capabilities');
  return ctx.window.__createDownloads;
}

/** A fake source: `chunks` chunks of `size` bytes every `every` ms; can fail, or stall. */
function source({ chunks = 8, size = 64 * 1024, every = 5, status = 200, stallAfter = Infinity }) {
  const state = { aborted: false, calls: 0 };
  state.fetch = (url, { signal }) => {
    state.calls++;
    signal.addEventListener('abort', () => (state.aborted = true));
    if (status !== 200) return Promise.resolve({ ok: false, status, body: null });
    let sent = 0;
    const reader = {
      read: () =>
        new Promise((resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort);
          if (sent >= stallAfter) return; // never resolves: a stalled connection
          setTimeout(() => {
            if (sent >= chunks) return resolve({ done: true });
            sent++;
            resolve({ done: false, value: new Uint8Array(size) });
          }, every);
        }),
    };
    return Promise.resolve({ ok: true, status: 200, body: { getReader: () => reader } });
  };
  return state;
}

/** Route each URL to its fake source. */
function router(map) {
  return (url, init) => map[url].fetch(url, init);
}

const now = () => Date.now();

test('the faster source wins and the slower one is cancelled', async () => {
  const create = load();
  const slow = source({ every: 40, size: 16 * 1024, chunks: 30 });
  const fast = source({ every: 5, size: 64 * 1024, chunks: 6 });
  const dl = create(router({ a: slow, b: fast }), now, { winBytes: 128 * 1024, stallMs: 2000 });
  const r = await dl.fetch('model', ['a', 'b']);
  assert.equal(r.url, 'b');
  assert.equal(r.bytes.length, 6 * 64 * 1024);
  assert.ok(slow.aborted, 'the losing download should be aborted');
  assert.equal(dl.retries, 0);
});

test('a source that errors is ignored while another works', async () => {
  const create = load();
  const broken = source({ status: 404 });
  const ok = source({ every: 5, chunks: 4 });
  const dl = create(router({ a: broken, b: ok }), now, { stallMs: 2000 });
  const r = await dl.fetch('wasm', ['a', 'b']);
  assert.equal(r.url, 'b');
});

test('when every source fails it retries once, then rejects', async () => {
  const create = load();
  const a = source({ status: 404 });
  const b = source({ status: 503 });
  const dl = create(router({ a, b }), now, { stallMs: 2000 });
  await assert.rejects(dl.fetch('loader', ['a', 'b']));
  assert.equal(dl.retries, 1);
  assert.equal(a.calls, 2);
});

test('a leader that stalls mid-download is abandoned and the race runs again', async () => {
  const create = load();
  let attempt = 0;
  const flaky = {
    fetch: (url, init) => {
      attempt++;
      // first connection stalls after 3 chunks; the second completes
      return source(attempt === 1 ? { chunks: 8, stallAfter: 3 } : { chunks: 8 }).fetch(url, init);
    },
  };
  const dl = create(router({ a: flaky }), now, { winBytes: 64 * 1024, stallMs: 150 });
  const t0 = Date.now();
  const r = await dl.fetch('model', ['a']);
  assert.equal(r.bytes.length, 8 * 64 * 1024);
  assert.equal(dl.retries, 1);
  assert.ok(Date.now() - t0 < 2000, 'stall detection should be quick');
});

test('progress is reported per asset and ends at the full size', async () => {
  const create = load();
  const ok = source({ every: 2, chunks: 3 });
  const dl = create(router({ a: ok }), now, { stallMs: 2000 });
  let calls = 0;
  dl.onProgress = () => calls++;
  await dl.fetch('loader', ['a']);
  assert.ok(calls >= 3);
  assert.equal(dl.got.loader, dl.assets.loader.size);
});

test('download.js and assets.js agree on sizes and own-host paths', () => {
  const create = load();
  const dl = create(() => Promise.reject(new Error('unused')), now);
  for (const key of Object.keys(ASSETS)) {
    assert.equal(dl.assets[key].size, ASSETS[key].size, `${key} size`);
    assert.equal(dl.assets[key].urls[0], ASSETS[key].path, `${key} own-host path first`);
    assert.ok(dl.assets[key].urls.length >= 2, `${key} has a mirror`);
  }
});

test('pinned hashes match the vendored files', async () => {
  const { createHash } = await import('node:crypto');
  for (const key of Object.keys(ASSETS)) {
    const bytes = fs.readFileSync(new URL(`../${ASSETS[key].path}`, import.meta.url));
    assert.equal(bytes.length, ASSETS[key].size, `${key} size`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), ASSETS[key].sha256, `${key} sha256`);
  }
});
