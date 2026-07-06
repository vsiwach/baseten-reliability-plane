/* ?seed=42 twice → identical event streams. Asserted here, not eyeballed:
   we run the full engine through a scripted scenario (drill, rollout with a
   regression, certified migration) twice with the same seed and require the
   serialized event stream, hero metrics, and incident log to be identical.
   A different seed must produce a different stream (guards against a
   constant-output "determinism"). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('../js/sim/yaml-lite.js');
const { createEngine } = require('../js/sim/engine.js');
const { profiles } = require('../js/data/recorded.js');

function loadPolicies() {
  const read = n => yaml.parse(
    fs.readFileSync(path.join(__dirname, '..', 'policies', `${n}-policy.yaml`), 'utf8'));
  return { slo: read('slo'), release: read('release'),
           placement: read('placement'), failover: read('failover') };
}

function scriptedRun(seed) {
  const eng = createEngine({ seed, policies: loadPolicies(), profiles });
  for (let i = 0; i < 10; i++) eng.tick(1);
  eng.runDrill();
  for (let i = 0; i < 40; i++) eng.tick(1);
  eng.startRollout();
  for (let i = 0; i < 8; i++) eng.tick(1);
  eng.injectRegression();
  for (let i = 0; i < 20; i++) eng.tick(1);
  eng.startMigration('in');
  for (let i = 0; i < 40; i++) eng.tick(1);
  return JSON.stringify({
    events: eng.eventsView(),
    hero: eng.heroMetrics(),
    incidents: eng.incidentsView(),
    pools: eng.poolsView(),
    migration: eng.migrationView(),
    release: eng.releaseView(),
  });
}

test('seed 42 twice → byte-identical event streams and state', () => {
  assert.strictEqual(scriptedRun(42), scriptedRun(42));
});

test('a different seed → a different stream (the sim is actually random)', () => {
  assert.notStrictEqual(scriptedRun(42), scriptedRun(1337));
});

test('the scripted scenario actually exercised the machinery', () => {
  const state = JSON.parse(scriptedRun(42));
  assert.ok(state.incidents.length >= 1, 'drill opened an incident');
  assert.ok(state.incidents.some(i => !i.live && i.mttr_s > 0), 'incident resolved with MTTR');
  assert.strictEqual(state.release.state, 'rolled_back', 'regression auto-rolled-back');
  assert.strictEqual(state.migration.serving, 'baseten-dedicated', 'migration promoted');
  assert.ok(state.migration.rollbackArmed, 'rollback held after promote');
});
