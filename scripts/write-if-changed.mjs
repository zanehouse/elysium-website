// write-if-changed.mjs — skip the write when only the run clock moved.
//
// Every build script stamps its output with `generated: new Date().toISOString()`,
// so a naive writeFile guarantees a git diff on every run even when the numbers
// are byte-identical. That made the `git diff --cached --quiet` guard in both
// workflows dead code, and at a 15-minute cadence it would commit ~2.6 MB of
// GEX JSON 32x a day for nothing.
//
// This compares the payload with the run-clock keys removed. Data that really
// moved still gets written (with a fresh `generated`); a quiet weekend or a
// closed market writes nothing at all.
//
// Note it deliberately does NOT ignore CBOE's `asof` — that's the exchange's own
// timestamp and the tool pages surface it as "as of", so a change there is real
// information and must be persisted.

import { writeFile, readFile } from 'node:fs/promises';

// JSON.stringify isn't key-order-stable across runs, so canonicalize before
// comparing: object keys sorted, arrays left in order (order is meaningful for
// contracts/series).
function canonical(value, ignoreKeys) {
  if (Array.isArray(value)) return value.map((v) => canonical(v, ignoreKeys));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (ignoreKeys.has(key)) continue;
      out[key] = canonical(value[key], ignoreKeys);
    }
    return out;
  }
  return value;
}

/**
 * Write `obj` to `filePath` only if it differs from what's already there,
 * ignoring the given top-level-or-nested keys during the comparison.
 *
 * @returns {Promise<boolean>} true if the file was written, false if skipped.
 */
export async function writeIfChanged(filePath, obj, { ignoreKeys = ['generated'], pretty = false } = {}) {
  const body = pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj);
  const ignore = new Set(ignoreKeys);

  let existing;
  try {
    existing = await readFile(filePath, 'utf8');
  } catch {
    await writeFile(filePath, body);   // no prior file — always write
    return true;
  }

  try {
    const before = canonical(JSON.parse(existing), ignore);
    const after = canonical(obj, ignore);
    if (JSON.stringify(before) === JSON.stringify(after)) return false;
  } catch {
    // Unparseable/corrupt file on disk — overwrite it rather than skip.
  }

  await writeFile(filePath, body);
  return true;
}
