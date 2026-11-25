import test from 'node:test';
import assert from 'node:assert/strict';

import { watchManifest, startFreshnessTicker } from '../common.js';

// Flushes microtasks queued by watchManifest's async check()/fetchImpl chain.
// setImmediate is a real macrotask (never included in the mocked API list
// below), so it reliably runs after every pending microtask has drained.
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('watchManifest fires onChange once generated differs from the baseline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetchImpl = async () => ({ ok: true, json: async () => ({ generated: 'B' }) });
  const seen = [];
  const w = watchManifest('A', (m) => seen.push(m.generated), { intervalMs: 1000, fetchImpl });

  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(seen, ['B']);
  w.stop();
});

test('watchManifest does not fire when generated is unchanged', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetchImpl = async () => ({ ok: true, json: async () => ({ generated: 'A' }) });
  const seen = [];
  const w = watchManifest('A', (m) => seen.push(m.generated), { intervalMs: 1000, fetchImpl });

  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(seen, []);
  w.stop();
});

test('watchManifest swallows a fetch failure and keeps polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let call = 0;
  const fetchImpl = async () => {
    call++;
    if (call === 1) throw new Error('network down');
    return { ok: true, json: async () => ({ generated: 'B' }) };
  };
  const seen = [];
  const w = watchManifest('A', (m) => seen.push(m.generated), { intervalMs: 1000, fetchImpl });

  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(seen, [], 'first check failed silently — no throw, no spurious fire');

  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(seen, ['B'], 'polling continued after the failure');
  w.stop();
});

test('watchManifest.stop() prevents further checks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ generated: 'B' }) }; };
  const w = watchManifest('A', () => {}, { intervalMs: 1000, fetchImpl });

  w.stop();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(calls, 0);
});

test('watchManifest pauses while the tab is hidden and checks immediately on resume', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ generated: 'B' }) }; };

  let hidden = true;
  let listener = null;
  const prevDocument = globalThis.document;
  globalThis.document = {
    get hidden() { return hidden; },
    addEventListener: (type, fn) => { if (type === 'visibilitychange') listener = fn; },
    removeEventListener: () => {},
  };

  try {
    const w = watchManifest('A', () => {}, { intervalMs: 1000, fetchImpl });
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(calls, 0, 'no checks fire while hidden, however long the clock runs');

    hidden = false;
    listener();   // simulate the browser's visibilitychange event
    await flush();
    assert.equal(calls, 1, 'resume triggers an immediate check, not a wait for the next tick');
    w.stop();
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
});

// ── startFreshnessTicker ─────────────────────────────────────────────────
test('startFreshnessTicker renders immediately and updates live, rounding down', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const el = { textContent: '' };
  const start = Date.now();

  const stop = startFreshnessTicker(el, start);
  assert.equal(el.textContent, '0s ago');

  t.mock.timers.tick(5000);
  assert.equal(el.textContent, '5s ago');

  t.mock.timers.tick(58000);   // total elapsed 63s -> floor(63/60) = 1m, not 63s
  assert.equal(el.textContent, '1m ago');

  stop();
  t.mock.timers.tick(5000);
  assert.equal(el.textContent, '1m ago', 'a stopped ticker stops writing');
});

test('startFreshnessTicker on a missing element is a no-op, not a throw', () => {
  assert.doesNotThrow(() => startFreshnessTicker(null, Date.now())());
});
