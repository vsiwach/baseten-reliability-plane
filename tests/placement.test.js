const test = require('node:test');
const assert = require('node:assert');
const P = require('../js/sim/placement.js');

const policy = {
  capacity_preference: ['reserved', 'cheapest', 'lowest_latency'],
  compliance: { regimes: ['hipaa', 'pci'], sensitive_capacity_tags: ['sensitive'] },
  pools: [
    { id: 'baseten-dedicated', region: 'us-east-1', cost_rank: 2, cold_start_s: 148, tags: ['reserved'] },
    { id: 'baseten-model-api', region: 'us-east-1', cost_rank: 1, cold_start_s: 0, tags: [] },
    { id: 'hipaa-eu-pool', region: 'eu-west-1', cost_rank: 4, cold_start_s: 60,
      tags: ['sensitive'], compliance_regimes: ['hipaa'] },
  ],
};

test('the capacity-preference toggle changes where the next workload lands', () => {
  const w = { region: 'us-east-1' };
  const reservedFirst = P.eligiblePools(w, policy, 'reserved');
  assert.strictEqual(reservedFirst[0].id, 'baseten-dedicated', 'reserved-first picks the reserved pool');
  const cheapest = P.eligiblePools(w, policy, 'cheapest');
  assert.strictEqual(cheapest[0].id, 'baseten-model-api', 'cheapest picks by cost_rank');
});

test('compliance-bound work is DENIED ordinary capacity', () => {
  const w = { compliance: 'hipaa' };
  const pools = P.eligiblePools(w, policy);
  assert.deepStrictEqual(pools.map(p => p.id), ['hipaa-eu-pool'], 'only matching sensitive pools');
  const plan = P.planAdmission(w, policy.pools[0], [], 4, policy);
  assert.strictEqual(plan.action, P.DENY);
});

test('RIGHT OF WAY: compliance work preempts filler on sensitive capacity', () => {
  const w = { compliance: 'hipaa' };
  const pool = policy.pools[2];
  const occupants = [{ id: 'filler-1', compliance: null }, { id: 'hipaa-1', compliance: 'hipaa' }];
  const plan = P.planAdmission(w, pool, occupants, 2, policy);
  assert.strictEqual(plan.action, P.PREEMPT);
  assert.strictEqual(plan.victim, 'filler-1', 'the non-compliant occupant is evicted');
});

test('full of compliant work → queue, never preempt a peer', () => {
  const w = { compliance: 'hipaa' };
  const pool = policy.pools[2];
  const occupants = [{ id: 'a', compliance: 'hipaa' }, { id: 'b', compliance: 'hipaa' }];
  const plan = P.planAdmission(w, pool, occupants, 2, policy);
  assert.strictEqual(plan.action, P.QUEUE);
});

test('non-compliant work ranks sensitive capacity last (preemptible filler)', () => {
  const w = {};
  const pools = P.eligiblePools(w, policy, 'cheapest');
  assert.strictEqual(pools[pools.length - 1].id, 'hipaa-eu-pool');
});

test('every decision carries a human-readable reason string', () => {
  const r = P.reason({ region: 'us-east-1' }, policy.pools[0], 'reserved', 412, 500);
  assert.ok(r.includes('route→baseten-dedicated'));
  assert.ok(r.includes('policy=us-east-1 ✓'));
  assert.ok(r.includes('reserved-first'));
  assert.ok(r.includes('ttft_p99 412ms<500ms'));
});
