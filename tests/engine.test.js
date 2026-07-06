/* End-to-end behaviors the acceptance checklist demands, driven through the
   engine exactly as the console's buttons drive it. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('../js/sim/yaml-lite.js');
const { createEngine } = require('../js/sim/engine.js');
const { profiles } = require('../js/data/recorded.js');

function policies() {
  const read = n => yaml.parse(
    fs.readFileSync(path.join(__dirname, '..', 'policies', `${n}-policy.yaml`), 'utf8'));
  return { slo: read('slo'), release: read('release'),
           placement: read('placement'), failover: read('failover') };
}
const boot = seed => createEngine({ seed, policies: policies(), profiles });

test('Run drill: quarantine → probes → reinstate → resolve, MTTR + evidence card', () => {
  const eng = boot(42);
  for (let i = 0; i < 8; i++) eng.tick(1);
  eng.runDrill();
  for (let i = 0; i < 45 && !(eng.drillView() || {}).done; i++) eng.tick(1);
  const drill = eng.drillView();
  assert.ok(drill.done, 'drill resolved');
  assert.ok(drill.evidence.mttr_s > 0, 'stopwatch shows a value');
  assert.ok(drill.evidence.did.some(a => a.includes('quarantined')), 'agent quarantined');
  assert.ok(drill.evidence.did.some(a => a.includes('probe passed')), 'agent probed');
  assert.ok(drill.evidence.did.some(a => a.includes('reinstated')), 'agent reinstated');
  assert.deepStrictEqual(drill.evidence.allowlist,
    ['quarantine', 'probe', 'reinstate', 'resolve', 'escalate']);
  const c = drill.evidence.contract;
  assert.ok(c && c.total > 0, 'contract ledger scored the route during the incident');
  assert.ok(c.intact, 'SLO contract intact — budget spent, contract held');
  assert.ok(c.budget_pct < 1, `incident consumed a sliver of the monthly error budget (${c.budget_pct}%)`);
});

test('Rigged drill: the guard refuses to orphan the last healthy pool', () => {
  const eng = boot(42);
  for (let i = 0; i < 8; i++) eng.tick(1);
  eng.runRiggedDrill();
  for (let i = 0; i < 45 && !(eng.drillView() || {}).done; i++) eng.tick(1);
  const drill = eng.drillView();
  assert.ok(drill.done, 'rigged drill resolved');
  assert.ok(drill.evidence.did.some(a => a.includes('WITHHELD')), 'quarantine withheld and logged');
  assert.ok(drill.evidence.guards.some(g => g.includes('last-healthy-pool guard HELD')));
  const dedicated = eng.poolsView().find(p => p.id === 'baseten-dedicated');
  assert.ok(!dedicated.quarantined, 'the last pool never left rotation');
});

test('placement toggle changes where the next workload lands, reason updates', () => {
  const eng = boot(42);
  for (let i = 0; i < 6; i++) eng.tick(1);
  const lastPlacement = () => eng.eventsView().filter(e => e.kind === 'placement'
    && e.text.startsWith('route→')).pop().text;
  eng.setOverride('capacity_preference', 'reserved');
  for (let i = 0; i < 4; i++) eng.tick(1);
  const reservedLine = lastPlacement();
  assert.ok(reservedLine.includes('route→baseten-dedicated'), `reserved-first lands on dedicated: ${reservedLine}`);
  assert.ok(reservedLine.includes('reserved-first'));
  eng.setOverride('capacity_preference', 'cheapest');
  for (let i = 0; i < 4; i++) eng.tick(1);
  const cheapestLine = lastPlacement();
  assert.ok(cheapestLine.includes('route→baseten-model-api'), `cheapest lands on model-api: ${cheapestLine}`);
  assert.ok(cheapestLine.includes('cheapest'));
});

test('migration IN promotes voice-agent onto baseten-dedicated; rollback restores', () => {
  const eng = boot(42);
  for (let i = 0; i < 5; i++) eng.tick(1);
  eng.startMigration('in');
  for (let i = 0; i < 40 && !(eng.migrationView() || {}).finished; i++) eng.tick(1);
  const m = eng.migrationView();
  assert.strictEqual(m.verdict, 'PROMOTE_ELIGIBLE');
  assert.strictEqual(m.serving, 'baseten-dedicated');
  assert.ok(m.cert.deltas.ttft_p99_ms.source && m.cert.deltas.ttft_p99_ms.target,
    'side-by-side parity deltas');
  assert.strictEqual(eng.routesView().find(r => r.id === 'voice-agent').pool,
    'baseten-dedicated', 'route actually moved');
  eng.rollbackMigration();
  assert.strictEqual(eng.routesView().find(r => r.id === 'voice-agent').pool,
    'competitor-cloud', 'one click restores the original pool');
});

test('win-back card appears for the external route that is cheaper at equal SLO', () => {
  const eng = boot(42);
  for (let i = 0; i < 10; i++) eng.tick(1);
  const recs = eng.winbackView();
  assert.ok(recs.length >= 1, 'ledger recommends the migration');
  assert.strictEqual(recs[0].route, 'voice-agent');
  assert.strictEqual(recs[0].from, 'competitor-cloud');
  assert.strictEqual(recs[0].to, 'baseten-dedicated');
  assert.ok(recs[0].delta_pct > 0);
});

test('failover: quarantining cluster-1 moves its route to cluster-2, and recovery returns it', () => {
  const eng = boot(42);
  for (let i = 0; i < 6; i++) eng.tick(1);
  assert.strictEqual(eng.routesServingView().find(r => r.id === 'voice-prod').serving,
    'baseten-dedicated', 'declared pool serves while healthy');
  eng.operatorQuarantine('baseten-dedicated');
  for (let i = 0; i < 5; i++) eng.tick(1);
  const r = eng.routesServingView().find(r => r.id === 'voice-prod');
  assert.strictEqual(r.serving, 'baseten-dedicated-2',
    'traffic failed over to the second Baseten cluster per spill_order');
  const b2 = eng.poolsView().find(p => p.id === 'baseten-dedicated-2');
  assert.ok(b2.serving && b2.rps > 0, 'cluster-2 visibly carries the traffic');
  assert.ok(eng.eventsView().some(e => e.kind === 'failover' &&
    e.text.includes('voice-prod → baseten-dedicated-2')), 'failover is an event, not an inference');
  eng.operatorReinstate('baseten-dedicated');
  for (let i = 0; i < 3; i++) eng.tick(1);
  assert.strictEqual(eng.routesServingView().find(r => r.id === 'voice-prod').serving,
    'baseten-dedicated', 'recovery returns traffic to the declared pool');
  assert.ok(eng.eventsView().some(e => e.text.startsWith('recovery: voice-prod')));
});

test('failover disabled by policy: traffic stays on the declared pool', () => {
  const eng = boot(42);
  for (let i = 0; i < 4; i++) eng.tick(1);
  eng.setOverride('spill_enabled', false);
  eng.operatorQuarantine('baseten-dedicated');
  for (let i = 0; i < 4; i++) eng.tick(1);
  assert.strictEqual(eng.routesServingView().find(r => r.id === 'voice-prod').serving,
    'baseten-dedicated', 'no spill when the policy toggle is off');
});

test('hero metrics are null before traffic — no zeros pretending to be data', () => {
  const eng = boot(42);
  const h = eng.heroMetrics();
  assert.strictEqual(h.goodput, null);
  assert.strictEqual(h.ttft_p99_ms, null);
  for (let i = 0; i < 5; i++) eng.tick(1);
  assert.ok(eng.heroMetrics().goodput !== null, 'data appears once traffic flows');
});
