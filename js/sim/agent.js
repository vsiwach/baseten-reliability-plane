/* agent.js — the governed incident agent, ported faithfully from
   baseten-mvp router_app/incident_agent.py (IncidentAgentLogic — the pure,
   clock-injected decision core; F2.1, F2.2).

   The agent's production authority is a CLOSED ALLOWLIST:

       quarantine  eject pool from rotation — traffic spills to healthy pools
       probe       direct streaming-TTFT request to the sick pool
       reinstate   lift quarantine after consecutive passing probes
       resolve     close the incident once service SLO is restored
       escalate    page a human ONCE when probes keep failing, then slow-poll

   Guards (each unit-tested):
   - NEVER quarantine the last healthy pool: the guard counts the pools that
     would be LEFT; a same-tick second breach can never orphan the service.
   - Sticky quarantine: a passing healthz does NOT lift it (a latency-poisoned
     pool answers /healthz fine); only verified probes reinstate.
   - Escalate once, then slow-poll (5× interval) so a stuck quarantine never
     hammers a rate-limited upstream (friction #10).
   - MONITOR-ONLY pools are outside the agent's authority, structurally: the
     decision core refuses to open cases or emit any acting effect against a
     pool whose control is not 'operated'. It records an `observe` effect so
     the breach is visible — the only affordance on external pools is
     "Migrate route", and that is a human's button. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.RP = root.RP || {}; root.RP.agent = factory(); }
})(globalThis, function () {
  'use strict';

  const ALLOWLIST = ['quarantine', 'probe', 'reinstate', 'resolve', 'escalate'];

  const DEFAULT_CONFIG = {
    breach_rate_threshold: 0.5,
    min_samples: 4,
    probe_interval_s: 3.0,
    probes_to_reinstate: 2,
    cooldown_s: 30.0,
    probe_slo_ms: 500.0,        // judged against the route's SLO tier
    escalate_after_failures: 5,
  };

  /* signals: [{poolId, control: 'operated'|'monitor-only', usable,
                healthzOk, breachRate, samples}] */
  function createAgentLogic(config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const cases = new Map();          // poolId -> case
    const cooldownUntil = new Map();  // poolId -> t
    const observedUntil = new Map();  // monitor-only breach notices, throttled

    function breaching(sig) {
      return !sig.healthzOk ||
        (sig.samples >= cfg.min_samples && sig.breachRate >= cfg.breach_rate_threshold);
    }

    function maybeOpen(now, sig, healthyPools) {
      if (now < (cooldownUntil.get(sig.poolId) || 0)) return [];
      let kind, title, detect;
      if (!sig.healthzOk) {
        kind = 'pool_down';
        title = `${sig.poolId} down — health probe failing, traffic spilled`;
        detect = `health probe failed on ${sig.poolId}`;
      } else if (sig.samples >= cfg.min_samples &&
                 sig.breachRate >= cfg.breach_rate_threshold) {
        kind = 'slo_breach';
        title = `${sig.poolId} breaching serving SLO — ${Math.round(sig.breachRate * 100)}% of recent requests`;
        detect = `detected SLO breach rate ${Math.round(sig.breachRate * 100)}% over ${sig.samples} requests on ${sig.poolId}`;
      } else {
        return [];
      }
      /* The guard protects the pools that would be LEFT: a sick pool that is
         already unusable contributes nothing, so quarantining it costs
         nothing — count the others only. */
      const othersUsable = healthyPools - (sig.usable ? 1 : 0);
      if (othersUsable < 1) {
        title += ' · last healthy pool, quarantine withheld';
      }
      const c = { poolId: sig.poolId, kind, phase: 'diagnose', quarantined: false,
                  probesPassed: 0, probesFailed: 0, escalated: false, nextProbeAt: 0 };
      cases.set(sig.poolId, c);
      const effects = [
        { op: 'open', poolId: sig.poolId, title },
        { op: 'act', poolId: sig.poolId, action: detect, phase: 'diagnose' },
      ];
      if (othersUsable >= 1) {
        c.quarantined = true;
        c.phase = 'resolve';
        effects.push({ op: 'quarantine', poolId: sig.poolId });
        effects.push({ op: 'act', poolId: sig.poolId, phase: 'resolve',
                       action: `quarantined ${sig.poolId}; traffic spills to healthy pools` });
      } else {
        effects.push({ op: 'act', poolId: sig.poolId, phase: 'resolve',
                       action: `quarantine WITHHELD — ${sig.poolId} is the last healthy pool; ` +
                               'taking it out would take the service down (guard)' });
      }
      c.nextProbeAt = now + cfg.probe_interval_s;
      return effects;
    }

    function workCase(now, c, sig) {
      const effects = [];
      if (c.kind === 'pool_down') {
        if (sig.healthzOk) effects.push(...reinstateAndResolve(now, c, 'health probe recovered'));
        return effects;
      }
      /* slo_breach: probe the sick pool directly until it behaves. After
         escalation the case is a human's; slow-poll so a stuck quarantine
         doesn't hammer (and further rate-limit) the upstream. */
      if (now >= c.nextProbeAt) {
        c.nextProbeAt = now + cfg.probe_interval_s * (c.escalated ? 5 : 1);
        effects.push({ op: 'probe', poolId: c.poolId });
      }
      return effects;
    }

    function reinstateAndResolve(now, c, why) {
      const effects = [];
      if (c.quarantined) {
        effects.push({ op: 'reinstate', poolId: c.poolId });
        effects.push({ op: 'act', poolId: c.poolId, phase: 'resolve',
                       action: `reinstated ${c.poolId} — ${why}` });
      }
      effects.push({ op: 'resolve', poolId: c.poolId });
      cases.delete(c.poolId);
      cooldownUntil.set(c.poolId, now + cfg.cooldown_s);
      return effects;
    }

    /* One decision tick. Consumes signals, returns effect dicts the caller
       executes. healthyPools counts USABLE OPERATED pools only — monitor-only
       capacity is not the agent's to spend. */
    function step(now, signals, healthyPools) {
      const effects = [];
      for (const sig of signals) {
        /* Authority boundary: monitor-only pools never get a case. */
        if (sig.control !== 'operated') {
          if (breaching(sig) && now >= (observedUntil.get(sig.poolId) || 0)) {
            observedUntil.set(sig.poolId, now + cfg.cooldown_s);
            effects.push({ op: 'observe', poolId: sig.poolId,
                           note: `SLO breach observed on ${sig.poolId} — monitor-only, ` +
                                 'outside agent authority; "Migrate route" is the only affordance' });
          }
          continue;
        }
        const c = cases.get(sig.poolId);
        if (!c) {
          const opened = maybeOpen(now, sig, healthyPools);
          /* healthyPools was a tick-start snapshot: a quarantine we just
             issued reduces it NOW, so two pools breaching in the same tick
             can never both be quarantined. */
          if (sig.usable && opened.some(e => e.op === 'quarantine')) healthyPools -= 1;
          effects.push(...opened);
        } else {
          effects.push(...workCase(now, c, sig));
        }
      }
      return effects;
    }

    /* Probe verdicts come back asynchronously; a pass streak reinstates,
       a failure streak escalates ONCE. */
    function recordProbe(now, poolId, ok, latencyMs) {
      const c = cases.get(poolId);
      if (!c) return [];
      const effects = [{ op: 'act', poolId, phase: 'resolve',
                         action: `probe ${ok ? 'passed' : 'failed'} (${Math.round(latencyMs)}ms, gate ${Math.round(cfg.probe_slo_ms)}ms)` }];
      if (ok) {
        c.probesPassed += 1;
        c.probesFailed = 0;
        if (c.probesPassed >= cfg.probes_to_reinstate) {
          effects.push(...reinstateAndResolve(now, c,
            `${c.probesPassed} consecutive probes within SLO`));
        }
      } else {
        c.probesPassed = 0;
        c.probesFailed += 1;
        if (c.probesFailed >= cfg.escalate_after_failures && !c.escalated) {
          c.escalated = true;
          effects.push({ op: 'escalate', poolId });
          effects.push({ op: 'act', poolId, phase: 'resolve',
                         action: `escalating to on-call — ${c.probesFailed} consecutive probes failed; ` +
                                 'quarantine held, fault beyond agent allowlist; probe cadence slowed 5×' });
        }
      }
      return effects;
    }

    return {
      config: cfg,
      get cases() { return cases; },
      step, recordProbe,
      ALLOWLIST,
    };
  }

  return { createAgentLogic, ALLOWLIST, DEFAULT_CONFIG };
});
