/* The js/data/policies.js mirror exists only because file:// cannot fetch.
   It must be byte-for-byte identical to the YAML files, and yaml-lite must
   parse the real files into the shapes the engine relies on. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('../js/sim/yaml-lite.js');
const policyText = require('../js/data/policies.js');

const file = n => fs.readFileSync(
  path.join(__dirname, '..', 'policies', `${n}-policy.yaml`), 'utf8');

test('embedded policy mirrors are verbatim copies of policies/*.yaml', () => {
  for (const n of ['slo', 'release', 'placement', 'failover']) {
    assert.strictEqual(policyText[n], file(n), `${n}-policy.yaml drifted from its JS mirror`);
  }
});

test('yaml-lite parses slo-policy into the engine’s shape', () => {
  const p = yaml.parse(file('slo'));
  assert.strictEqual(p.slo.ttft_p99_ms, 500);
  assert.strictEqual(p.slo.tpot_p99_ms, 50);
  assert.strictEqual(p.slo.goodput_target, 0.99);
  assert.strictEqual(p.agent.probes_to_reinstate, 2);
  assert.strictEqual(p.agent.escalate_after_failures, 5);
});

test('yaml-lite parses release-policy (nested maps, inline lists, bools)', () => {
  const p = yaml.parse(file('release'));
  assert.deepStrictEqual(p.rollouts.default.steps, [5, 25, 100]);
  assert.strictEqual(p.rollouts.default.mode, 'canary');
  assert.strictEqual(p.rollouts.default.auto_rollback, true);
  assert.strictEqual(p.rollouts.default.probe.max_ms, 500);
  assert.strictEqual(p.rollouts['shadow-eval'].mode, 'shadow');
});

test('yaml-lite parses placement-policy (block list of maps, comments)', () => {
  const p = yaml.parse(file('placement'));
  assert.deepStrictEqual(p.capacity_preference, ['reserved', 'cheapest', 'lowest_latency']);
  assert.strictEqual(p.pools.length, 4, 'exactly the four pools (RunPod row stays commented)');
  const ids = p.pools.map(x => x.id);
  assert.deepStrictEqual(ids, ['baseten-dedicated', 'baseten-dedicated-2',
                               'baseten-model-api', 'modal-dedicated']);
  const cluster2 = p.pools[1];
  assert.strictEqual(cluster2.control, 'operated');
  assert.deepStrictEqual(cluster2.tags, ['reserved'], 'the declared failover cluster');
  assert.strictEqual(p.pools[3].control, 'monitor-only');
});

test('yaml-lite parses failover-policy (folded multi-line values)', () => {
  const p = yaml.parse(file('failover'));
  assert.deepStrictEqual(p.failover.spill_order,
    ['baseten-dedicated-2', 'baseten-model-api'],
    'second cluster first, serverless absorbs the rest');
  assert.strictEqual(p.hazards[0].friction, 10);
  assert.ok(p.hazards[0].note.includes('SAME budget'), 'folded lines joined');
});
