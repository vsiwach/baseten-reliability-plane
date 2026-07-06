/* The agent's guards are the product. Each test here maps to a guard the
   recorded episodes exercised live (baseten-mvp incident_agent tests). */
const test = require('node:test');
const assert = require('node:assert');
const { createAgentLogic, ALLOWLIST } = require('../js/sim/agent.js');

const sig = (over = {}) => ({
  poolId: 'pool-a', control: 'operated', usable: true, healthzOk: true,
  breachRate: 0, samples: 10, ...over,
});

test('breaching pool is quarantined when healthy capacity remains', () => {
  const a = createAgentLogic();
  const effects = a.step(0, [sig({ breachRate: 0.8 })], 2);
  const ops = effects.map(e => e.op);
  assert.ok(ops.includes('open'));
  assert.ok(ops.includes('quarantine'));
});

test('GUARD: the last healthy pool is never quarantined', () => {
  const a = createAgentLogic();
  const effects = a.step(0, [sig({ breachRate: 1.0 })], 1);   // only 1 healthy
  const ops = effects.map(e => e.op);
  assert.ok(ops.includes('open'), 'incident still opens');
  assert.ok(!ops.includes('quarantine'), 'quarantine withheld');
  assert.ok(effects.find(e => e.op === 'open').title.includes('quarantine withheld'));
});

test('GUARD: two pools breaching in the same tick cannot both be quarantined', () => {
  const a = createAgentLogic();
  const effects = a.step(0, [
    sig({ poolId: 'pool-a', breachRate: 1.0 }),
    sig({ poolId: 'pool-b', breachRate: 1.0 }),
  ], 2);
  const quarantines = effects.filter(e => e.op === 'quarantine');
  assert.strictEqual(quarantines.length, 1, 'only the first breach quarantines');
});

test('sticky quarantine: reinstate only after N consecutive passing probes', () => {
  const a = createAgentLogic({ probes_to_reinstate: 2 });
  a.step(0, [sig({ breachRate: 1.0 })], 2);
  let fx = a.recordProbe(1, 'pool-a', true, 100);
  assert.ok(!fx.some(e => e.op === 'reinstate'), 'one pass is not enough');
  fx = a.recordProbe(2, 'pool-a', false, 900);   // failure resets the streak
  fx = a.recordProbe(3, 'pool-a', true, 100);
  assert.ok(!fx.some(e => e.op === 'reinstate'), 'streak reset by failure');
  fx = a.recordProbe(4, 'pool-a', true, 100);
  assert.ok(fx.some(e => e.op === 'reinstate'), 'two consecutive passes reinstate');
  assert.ok(fx.some(e => e.op === 'resolve'));
});

test('escalates exactly once, then slow-polls at 5x the probe interval', () => {
  const a = createAgentLogic({ escalate_after_failures: 3, probe_interval_s: 3 });
  a.step(0, [sig({ breachRate: 1.0 })], 2);
  a.recordProbe(1, 'pool-a', false, 900);
  a.recordProbe(2, 'pool-a', false, 900);
  const fx = a.recordProbe(3, 'pool-a', false, 900);
  assert.ok(fx.some(e => e.op === 'escalate'), 'third consecutive failure escalates');
  const fx2 = a.recordProbe(4, 'pool-a', false, 900);
  assert.ok(!fx2.some(e => e.op === 'escalate'), 'escalates only once');
  // slow poll: after escalation the next probe is scheduled 15s out, not 3s
  const c = a.cases.get('pool-a');
  const before = c.nextProbeAt;
  a.step(before, [sig({ breachRate: 1.0 })], 2);   // fires a probe, reschedules
  assert.ok(a.cases.get('pool-a').nextProbeAt - before >= 15, 'cadence slowed 5x');
});

test('cooldown: a resolved pool is not immediately re-opened', () => {
  const a = createAgentLogic({ cooldown_s: 30 });
  a.step(0, [sig({ breachRate: 1.0 })], 2);
  a.recordProbe(1, 'pool-a', true, 100);
  a.recordProbe(2, 'pool-a', true, 100);          // resolved at t=2
  const fx = a.step(10, [sig({ breachRate: 1.0 })], 2);
  assert.strictEqual(fx.length, 0, 'still cooling down');
  const fx2 = a.step(40, [sig({ breachRate: 1.0 })], 2);
  assert.ok(fx2.some(e => e.op === 'open'), 'reopens after cooldown');
});

test('STRUCTURAL: the agent refuses every action against a monitor-only pool', () => {
  const a = createAgentLogic();
  const monitorSig = sig({ poolId: 'modal-dedicated', control: 'monitor-only', breachRate: 1.0 });
  const effects = a.step(0, [monitorSig], 3);
  const acting = effects.filter(e => ALLOWLIST.includes(e.op) || e.op === 'open');
  assert.strictEqual(acting.length, 0, 'no case, no quarantine, no probe — nothing');
  assert.ok(effects.some(e => e.op === 'observe'), 'the breach is observed, not acted on');
  assert.ok(effects[0].note.includes('Migrate route'));
  // and probe verdicts for a pool with no case are ignored
  assert.strictEqual(a.recordProbe(1, 'modal-dedicated', false, 900).length, 0);
});

test('pool_down: already-unusable pool resolves when health returns', () => {
  const a = createAgentLogic();
  a.step(0, [sig({ healthzOk: false, usable: false })], 2);
  const fx = a.step(5, [sig({ healthzOk: true, usable: true })], 2);
  assert.ok(fx.some(e => e.op === 'resolve'), 'health recovery resolves the case');
});
