const test = require('node:test');
const assert = require('node:assert');
const M = require('../js/sim/migration.js');

const slo = { ttft_p99_ms: 500, tpot_p99_ms: 50 };
const goodPair = () => ({ srcTtft: 300, tgtTtft: 340, srcTpot: 33, tgtTpot: 35, parityOk: true });
const badPair = () => ({ srcTtft: 300, tgtTtft: 900, srcTpot: 33, tgtTpot: 35, parityOk: true });

test('shadow → certify → promote, with rollback held for the route’s life', () => {
  const m = M.createMigration({ route: 'voice-agent', source: 'modal-dedicated',
                                target: 'baseten-dedicated', slo, requiredSamples: 5 });
  assert.strictEqual(m.stage, 'shadow');
  for (let i = 0; i < 5; i++) m.feed(goodPair());
  assert.strictEqual(m.stage, 'certify', 'cohort full moves to certify');
  const cert = m.certify();
  assert.strictEqual(cert.verdict, M.PROMOTE_ELIGIBLE);
  assert.ok(cert.deltas.ttft_p99_ms.source > 0 && cert.deltas.ttft_p99_ms.target > 0,
    'side-by-side measured deltas present');
  assert.ok(m.promote());
  assert.strictEqual(m.serving, 'baseten-dedicated');
  assert.ok(m.rollbackArmed, 'rollback armed after promote');
  assert.ok(m.rollback());
  assert.strictEqual(m.serving, 'modal-dedicated', 'one click restores the original pool');
});

test('the gate refuses honestly: SLO miss → HOLD, no promotion possible', () => {
  const m = M.createMigration({ route: 'voice-agent', source: 'modal-dedicated',
                                target: 'baseten-dedicated', slo, requiredSamples: 5 });
  for (let i = 0; i < 5; i++) m.feed(badPair());
  const cert = m.certify();
  assert.strictEqual(cert.verdict, M.HOLD);
  assert.strictEqual(m.promote(), false, 'an automated run cannot skip the gate');
  assert.strictEqual(m.serving, 'modal-dedicated', 'route stays on the incumbent');
  assert.ok(m.finished);
});

test('parity below the gate refuses even when the SLO passes', () => {
  const m = M.createMigration({ route: 'r', source: 's', target: 't', slo,
                                requiredSamples: 10, parityGate: 0.9 });
  for (let i = 0; i < 10; i++) m.feed({ ...goodPair(), parityOk: i < 8 });   // 80%
  assert.strictEqual(m.certify().verdict, M.HOLD);
});

test('the same machine runs in either direction (no lock-in)', () => {
  const out = M.createMigration({ route: 'chat-prod', source: 'baseten-dedicated',
                                  target: 'modal-dedicated', slo, requiredSamples: 3 });
  for (let i = 0; i < 3; i++) out.feed(goodPair());
  out.certify();
  assert.ok(out.promote());
  assert.strictEqual(out.serving, 'modal-dedicated', 'migrate-out is one click too');
});

test('win-back fires only for external routes that would hold SLO cheaper on an operated pool', () => {
  const routes = [{ id: 'voice-agent', pool: 'modal-dedicated' },
                  { id: 'chat-prod', pool: 'baseten-dedicated' }];
  const pools = [
    { id: 'modal-dedicated', control: 'monitor-only', dedicated: true, usd_per_mtok: 10.19, ttft_p99_ms: 300 },
    { id: 'baseten-dedicated', control: 'operated', dedicated: true, usd_per_mtok: 8.53, ttft_p99_ms: 400 },
  ];
  const recs = M.winback(routes, pools, { ttft_p99_ms: 500 });
  assert.strictEqual(recs.length, 1, 'operated routes are never win-back targets');
  assert.strictEqual(recs[0].route, 'voice-agent');
  assert.strictEqual(recs[0].to, 'baseten-dedicated');
  assert.ok(recs[0].delta_pct >= 16);
  // if the operated pool breaches the SLO, no recommendation — cheap is not enough
  pools[1].ttft_p99_ms = 700;
  assert.strictEqual(M.winback(routes, pools, { ttft_p99_ms: 500 }).length, 0);
});
