/* Measured-only economics: one rule, and null — never zero — when the
   inputs aren't real. */
const test = require('node:test');
const assert = require('node:assert');
const C = require('../js/sim/costs.js');

test('usd_per_mtok = pool $/hr ÷ measured tokens/sec', () => {
  // the real T4x8x32 numbers: $0.9024/hr at 29.4 tok/s (TPOT 34 ms/tok)
  assert.strictEqual(Math.round(C.usdPerMtok(0.9024, 29.4) * 100) / 100, 8.53);
  assert.strictEqual(C.usdPerMtok(null, 29.4), null, 'no price → null, not zero');
  assert.strictEqual(C.usdPerMtok(0.9024, 0), null, 'no measured throughput → null');
});

test('goodput is null with no traffic — empty windows are not 100% or 0%', () => {
  assert.strictEqual(C.goodput(0, 0), null);
  assert.strictEqual(C.goodput(99, 100), 0.99);
});

test('percentile and median behave on small windows', () => {
  assert.strictEqual(C.percentile([], 99), null);
  assert.strictEqual(C.percentile([100], 99), 100);
  assert.strictEqual(C.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.strictEqual(C.median([8.1, 8.8, 9.2]), 8.8);
  assert.strictEqual(C.median([]), null);
});

test('blended $/Mtok refuses to blend unmeasured pools', () => {
  assert.strictEqual(
    C.blendedUsdPerMtok([{ usd_per_mtok: 8, tokens: 100 }, { usd_per_mtok: 2, tokens: 300 }]),
    3.5);
  assert.strictEqual(
    C.blendedUsdPerMtok([{ usd_per_mtok: 8, tokens: 100 }, { usd_per_mtok: null, tokens: 300 }]),
    null, 'one unmeasured pool poisons the blend — say "no data", not a fake');
});
