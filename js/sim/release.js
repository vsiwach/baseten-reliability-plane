/* release.js — the traffic-shifting release engine, ported from
   ai-native-pipeline router_app/release.py (F1.2). Pure logic, no I/O.

   canary  candidate gets an increasing % of real traffic (steps), each step
           gated by a success probe; a failing probe auto-rolls-back.
   shadow  candidate receives a MIRROR of traffic; the client only ever sees
           stable — zero client-visible effect.
   ab      a stable weighted split for comparison.

   Around a shift it warms up candidate replicas BEFORE sending them traffic,
   and drains stable replicas WITHOUT cutting in-flight requests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.RP = root.RP || {}; root.RP.release = factory(); }
})(globalThis, function () {
  'use strict';

  const CANARY = 'canary', SHADOW = 'shadow', AB = 'ab';
  const IN_PROGRESS = 'in_progress', COMPLETE = 'complete', ROLLED_BACK = 'rolled_back';

  // deterministic string → 0..99 bucket (djb2; no crypto needed in sim)
  function bucket(key) {
    let h = 5381;
    for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
    return h % 100;
  }

  function createRelease({ stable, candidate, mode = CANARY,
                           steps = [5, 25, 100], warmup = true, drain = true }) {
    const r = {
      stable, candidate, mode, steps, warmup, drain,
      stepIndex: -1,               // -1 = not started (0% candidate)
      state: IN_PROGRESS,
      history: [],
    };

    function candidateWeight() {
      if (r.state === ROLLED_BACK || r.stepIndex < 0) return 0;
      if (r.mode === SHADOW) return 0;   // shadow never shifts client traffic
      return r.steps[Math.min(r.stepIndex, r.steps.length - 1)];
    }

    function record(action, fields = {}) {
      const event = { action, mode: r.mode, stable: r.stable,
                      candidate: r.candidate, state: r.state, ...fields };
      r.history.push(event);
      return event;
    }

    /* Which version serves this request (what the CLIENT sees). */
    function route(key) {
      if (r.mode === SHADOW) return r.stable;
      return bucket(key) < candidateWeight() ? r.candidate : r.stable;
    }

    function mirrorToCandidate() {
      return r.mode === SHADOW && r.state === IN_PROGRESS;
    }

    /* Begin the rollout: warm up candidate before any traffic shifts. */
    function start() {
      r.stepIndex = 0;
      return record('start', { warmups: r.warmup ? [r.candidate] : [],
                               weight: candidateWeight() });
    }

    /* Gate the next step on a success probe. A failed probe auto-rolls-back. */
    function advance(probeOk) {
      if (r.state !== IN_PROGRESS) return record('noop', { weight: candidateWeight() });
      if (!probeOk) return rollback('probe_failed');
      if (r.stepIndex >= r.steps.length - 1) {
        r.state = COMPLETE;
        return record('complete', { drains: r.drain ? [r.stable] : [], weight: 100 });
      }
      r.stepIndex += 1;
      if (r.stepIndex >= r.steps.length - 1) {
        r.state = COMPLETE;   // advanced INTO the final (100%) step
        return record('complete', { drains: r.drain ? [r.stable] : [],
                                    weight: candidateWeight() });
      }
      return record('advance', { weight: candidateWeight() });
    }

    function rollback(reason = 'manual') {
      r.state = ROLLED_BACK;
      return record('rollback', { reason, weight: 0 });
    }

    return {
      get stable() { return r.stable; },
      get candidate() { return r.candidate; },
      get mode() { return r.mode; },
      get steps() { return r.steps; },
      get stepIndex() { return r.stepIndex; },
      get state() { return r.state; },
      get history() { return r.history; },
      candidateWeight, route, mirrorToCandidate, start, advance, rollback,
    };
  }

  /* A draining replica may only be stopped once it has no in-flight
     requests — this is what makes a rolling deploy lossless. */
  function canStopDrained(pending) { return pending === 0; }

  return { CANARY, SHADOW, AB, IN_PROGRESS, COMPLETE, ROLLED_BACK,
           createRelease, canStopDrained, bucket };
});
