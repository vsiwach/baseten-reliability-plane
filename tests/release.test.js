const test = require('node:test');
const assert = require('node:assert');
const R = require('../js/sim/release.js');

test('canary walks its gated steps to completion', () => {
  const r = R.createRelease({ stable: 'v1', candidate: 'v2', steps: [5, 25, 100] });
  assert.strictEqual(r.candidateWeight(), 0, 'not started = 0%');
  r.start();
  assert.strictEqual(r.candidateWeight(), 5);
  r.advance(true);
  assert.strictEqual(r.candidateWeight(), 25);
  const ev = r.advance(true);
  assert.strictEqual(r.state, R.COMPLETE, 'advancing into the final step completes');
  assert.strictEqual(r.candidateWeight(), 100);
  assert.deepStrictEqual(ev.drains, ['v1'], 'stable drains on completion');
});

test('a failed probe auto-rolls-back to 0%', () => {
  const r = R.createRelease({ stable: 'v1', candidate: 'v2' });
  r.start();
  r.advance(true);
  const ev = r.advance(false);
  assert.strictEqual(ev.action, 'rollback');
  assert.strictEqual(ev.reason, 'probe_failed');
  assert.strictEqual(r.state, R.ROLLED_BACK);
  assert.strictEqual(r.candidateWeight(), 0);
  assert.strictEqual(r.route('any-key'), 'v1', 'all traffic back on stable');
});

test('shadow mirrors without ever shifting client traffic', () => {
  const r = R.createRelease({ stable: 'v1', candidate: 'v2', mode: R.SHADOW });
  r.start();
  assert.strictEqual(r.candidateWeight(), 0);
  assert.strictEqual(r.route('req-123'), 'v1', 'client always sees stable');
  assert.ok(r.mirrorToCandidate(), 'candidate receives the mirror');
});

test('routing is deterministic and honors the step weight', () => {
  const r = R.createRelease({ stable: 'v1', candidate: 'v2', steps: [50, 100] });
  r.start();
  const first = Array.from({ length: 200 }, (_, i) => r.route('req-' + i));
  const second = Array.from({ length: 200 }, (_, i) => r.route('req-' + i));
  assert.deepStrictEqual(first, second, 'same key, same version');
  const share = first.filter(v => v === 'v2').length / 200;
  assert.ok(share > 0.3 && share < 0.7, `~50% split, got ${share}`);
});

test('a draining replica may stop only at zero in-flight', () => {
  assert.strictEqual(R.canStopDrained(3), false);
  assert.strictEqual(R.canStopDrained(0), true);
});
