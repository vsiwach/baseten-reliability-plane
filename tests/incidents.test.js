const test = require('node:test');
const assert = require('node:assert');
const { createIncidentStore } = require('../js/sim/incidents.js');

function fakeClock(start = 0) {
  let t = start;
  const clock = () => t;
  clock.advance = s => { t += s; };
  return clock;
}

test('incidents move detect → diagnose → resolve with per-phase timing', () => {
  const clock = fakeClock();
  const store = createIncidentStore({ clock });
  const inc = store.open('pool-a breaching serving SLO');
  clock.advance(2);
  store.act(inc.id, 'detected breach', 'diagnose');
  clock.advance(3);
  store.act(inc.id, 'quarantined pool-a', 'resolve');
  clock.advance(3.8);
  const done = store.resolve(inc.id);
  assert.strictEqual(done.mttr_s, 8.8);
  assert.strictEqual(done.phase_ms.detect, 2000);
  assert.strictEqual(done.phase_ms.diagnose, 3000);
  assert.strictEqual(done.phase_ms.resolve, 3800);
  assert.strictEqual(done.live, false);
});

test('live incidents report elapsed MTTR so the stopwatch counts up', () => {
  const clock = fakeClock();
  const store = createIncidentStore({ clock });
  store.open('slow burn');
  clock.advance(5.5);
  const snap = store.snapshot()[0];
  assert.strictEqual(snap.mttr_s, 5.5);
  assert.ok(snap.live);
});

test('mttrMedian splits agent and manual runs', () => {
  const clock = fakeClock();
  const store = createIncidentStore({ clock });
  for (const [mttr, agent] of [[8.1, true], [8.8, true], [9.2, true], [120, false]]) {
    const inc = store.open('x', agent);
    clock.advance(mttr);
    store.resolve(inc.id);
  }
  assert.strictEqual(store.mttrMedian(true), 8.8);
  assert.strictEqual(store.mttrMedian(false), 120);
  const empty = createIncidentStore({ clock });
  assert.strictEqual(empty.mttrMedian(true), null, 'no incidents → null, not 0');
});

test('acting on a resolved incident is a no-op', () => {
  const clock = fakeClock();
  const store = createIncidentStore({ clock });
  const inc = store.open('x');
  store.resolve(inc.id);
  assert.strictEqual(store.act(inc.id, 'too late'), null);
  assert.strictEqual(store.resolve(inc.id), null);
});
