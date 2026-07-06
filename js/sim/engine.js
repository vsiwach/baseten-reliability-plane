/* engine.js — the deterministic simulator core that composes every ported
   state machine: placement (F1.3/F1.4), release (F1.2), certified migration,
   the incident agent (F2.1/F2.2), incidents, and measured-only costs.

   Discipline ported from ai-native-pipeline: ALL decisions live in the pure
   modules; the engine sequences them on an injectable clock with every random
   draw taken from one seeded PRNG stream, so a given seed yields an identical
   event stream (tests/determinism.test.js). The UI only renders snapshots —
   no decision logic in DOM code.

   Honest numbers: each pool profile carries `source` (measured|simulated) and
   `provenance`; the engine never invents a measured figure. Simulated samples
   jitter around the profile's recorded operating point. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./prng.js'), require('./costs.js'),
      require('./placement.js'), require('./incidents.js'),
      require('./agent.js'), require('./release.js'), require('./migration.js'));
  } else {
    root.RP = root.RP || {};
    root.RP.engine = factory(root.RP.prng, root.RP.costs, root.RP.placement,
      root.RP.incidents, root.RP.agent, root.RP.release, root.RP.migration);
  }
})(globalThis, function (prng, costs, placement, incidentsMod, agentMod, releaseMod, migrationMod) {
  'use strict';

  const WINDOW_S = 15;          // rolling SLO window (slo-policy window_s)
  const MAX_EVENTS = 400;

  function createEngine({ seed = 42, policies, profiles }) {
    const rand = prng.mulberry32(seed);
    const slo = { ...policies.slo.slo };
    const agentCfg = { ...policies.slo.agent, probe_slo_ms: slo.ttft_p99_ms };
    const placementPolicy = policies.placement;
    const releaseDefaults = policies.release.rollouts.default;
    const failover = policies.failover.failover;

    const overrides = {
      capacity_preference: placementPolicy.capacity_preference[0],  // 'reserved'
      canary_steps: [...releaseDefaults.steps],
      spill_enabled: true,
      slo_ttft_ms: slo.ttft_p99_ms,
    };

    // ---- pools -------------------------------------------------------------
    const pools = placementPolicy.pools.map(p => {
      const prof = profiles[p.id] || {};
      return {
        ...p, ...prof,
        replicas: Array.from({ length: prof.replicas || 2 }, () => ({ state: 'warm', pending: 0 })),
        quarantined: false, healthy: true,
        chaos: null,                     // {latency_ms, until}
        window: [],                      // [{t, ttft, tpot, slo_met, route}]
        occupants: [],                   // [{id, compliance, until}]
        served_tokens: 0,
      };
    });
    const byId = Object.fromEntries(pools.map(p => [p.id, p]));

    const routes = [
      { id: 'voice-prod', pool: 'baseten-dedicated', rps: 2 },
      { id: 'voice-agent', pool: 'competitor-cloud', rps: 1 },   // monitored external route
    ];
    // the routes the customer's SLO contract covers: declared on operated pools
    const contractRoutes = new Set(
      routes.filter(r => (byId[r.pool] || {}).control === 'operated').map(r => r.id));

    // ---- shared machinery ----------------------------------------------------
    let t = 0, seq = 0;
    const lastServing = {};              // route.id -> pool actually serving it
    const events = [];
    const incidents = incidentsMod.createIncidentStore({ clock: () => t });
    const agent = agentMod.createAgentLogic(agentCfg);
    const incIds = new Map();            // poolId -> incident id
    let release = null, releaseGateAt = 0, regression = false, drainPending = null;
    let migration = null, migrationDir = null;
    let drill = null;                    // {kind, pool, clearAt, riggedPools?}
    const sparks = { goodput: [], ttft: [], tpot: [], cost: [] };

    function emit(kind, text, cls) {
      events.push({ seq: ++seq, t, kind, text, cls: cls || 'info' });
      if (events.length > MAX_EVENTS) events.shift();
    }

    function usable(p) {
      return p.healthy && !p.quarantined;
    }
    function operated(p) { return p.control === 'operated'; }

    function effectiveTtft(p) {
      const chaosMs = p.chaos && t < p.chaos.until ? p.chaos.latency_ms : 0;
      return p.ttft_ms + chaosMs;
    }

    /* Failover as declared policy: when a route's pool is unusable, traffic
       moves to the first usable pool in failover.spill_order (the second
       Baseten cluster first, then the serverless Model APIs). This is what
       keeps the SLO held while a pool is quarantined. */
    function spillTarget(excludeId) {
      const order = failover.spill_order || [];
      for (const id of order) {
        const p = byId[id];
        if (p && p.id !== excludeId && operated(p) && usable(p)) return p;
      }
      return null;
    }
    function effectivePoolId(route) {
      const p = byId[route.pool];
      if (!p || usable(p) || !operated(p)) return route.pool;
      if (!overrides.spill_enabled) return route.pool;   // policy off: degrade in place
      const s = spillTarget(route.pool);
      return s ? s.id : route.pool;
    }

    // ---- sampling ------------------------------------------------------------
    function sample(p, route) {
      const ttft = effectiveTtft(p) * prng.latencyJitter(rand);
      const tpot = p.tpot_ms * (0.85 + rand() * 0.4);
      const s = { t, ttft, tpot, route,
                  slo_met: ttft <= overrides.slo_ttft_ms && tpot <= slo.tpot_p99_ms };
      p.window.push(s);
      p.served_tokens += 40 + Math.floor(rand() * 120);
      // the contract ledger: while an incident is live, every CUSTOMER route
      // request (routes declared on operated pools) is scored against the
      // gate — this is what "SLO contract intact" is computed from
      if (drill && !drill.done && drill.contract && contractRoutes.has(route)) {
        drill.contract.total += 1;
        if (!s.slo_met) drill.contract.breached += 1;
      }
      return s;
    }

    function trimWindows() {
      for (const p of pools) {
        while (p.window.length && p.window[0].t < t - WINDOW_S) p.window.shift();
        p.occupants = p.occupants.filter(o => o.until > t);
      }
    }

    // ---- placement -----------------------------------------------------------
    function capacityOf(p) { return p.replicas.filter(r => r.state === 'warm').length * 2; }

    function placeWorkload(w) {
      const policy = { ...placementPolicy,
        pools: placementPolicy.pools.filter(pp => operated(byId[pp.id])) };
      const ranked = placement.eligiblePools(w, policy, overrides.capacity_preference)
        .map(pp => byId[pp.id]);
      const live = ranked.filter(usable);
      if (!live.length) { emit('placement', `no usable pool for ${w.id} — request parked`, 'warn'); return; }
      for (let i = 0; i < live.length; i++) {
        const p = live[i];
        const plan = placement.planAdmission(w, p, p.occupants, capacityOf(p), policy);
        if (plan.action === placement.ADMIT || plan.action === placement.PREEMPT) {
          if (plan.action === placement.PREEMPT) {
            p.occupants = p.occupants.filter(o => o.id !== plan.victim);
            emit('placement', `preempted flexible workload ${plan.victim} from ${p.id}; ` +
              'relocating per its policy — compliance right-of-way (F1.4)', 'warn');
          }
          p.occupants.push({ id: w.id, compliance: w.compliance, until: t + 4 + rand() * 6 });
          const p99 = costs.percentile(p.window.map(s => s.ttft), 99);
          emit('placement', placement.reason(w, p, overrides.capacity_preference, p99, overrides.slo_ttft_ms));
          sample(p, w.id);
          return;
        }
        if (plan.action === placement.QUEUE && i + 1 < live.length) {
          // the real failure class from friction #6: never hang silent
          emit('placement', `WAITING_FOR_CAPACITY on ${p.id} (queue pos ${p.occupants.length - capacityOf(p) + 1}, ` +
            `alt: ${live[i + 1].id} available) — friction #6 class`, 'warn');
          continue;
        }
        if (plan.action === placement.QUEUE) {
          emit('placement', `queued on ${p.id} — ${plan.reason}`, 'warn');
          return;
        }
      }
    }

    // ---- agent plumbing --------------------------------------------------------
    function signals() {
      // detection burns fast: the agent judges breach over the FRESHEST 5s,
      // not the full SLO window — every second of detection lag is degraded
      // customer requests spending error budget
      const BREACH_WINDOW_S = 5;
      const sigs = pools.map(p => {
        const win = p.window.filter(s => s.t > t - BREACH_WINDOW_S);
        const breaches = win.filter(s => !s.slo_met).length;
        return {
          poolId: p.id, control: p.control,
          usable: usable(p), healthzOk: p.healthy,
          breachRate: win.length ? breaches / win.length : 0,
          samples: win.length,
        };
      });
      const healthy = sigs.filter(s => s.control === 'operated' && s.usable).length;
      return { sigs, healthy };
    }

    function setReplicas(p, state) {
      for (const r of p.replicas) r.state = state;
    }

    function execute(effects) {
      for (const e of effects) {
        const p = byId[e.poolId];
        switch (e.op) {
          case 'open': {
            const inc = incidents.open(e.title, true);
            incIds.set(e.poolId, inc.id);
            emit('agent', `incident ${inc.id} opened: ${e.title}`, 'warn');
            break;
          }
          case 'act':
            if (incIds.has(e.poolId)) incidents.act(incIds.get(e.poolId), e.action, e.phase);
            break;
          case 'quarantine': {
            p.quarantined = true; setReplicas(p, 'quarantined');
            const next = overrides.spill_enabled && spillTarget(e.poolId);
            emit('agent', `agent: quarantine ${e.poolId} — traffic fails over to ` +
              `${next ? next.id : 'remaining pools'} per failover-policy`, 'warn');
            break;
          }
          case 'probe': {
            // streaming-TTFT probe against the sick pool, judged at the SLO gate
            const ms = effectiveTtft(p) * prng.latencyJitter(rand) * 0.8;
            const ok = ms <= agent.config.probe_slo_ms;
            execute(agent.recordProbe(t, e.poolId, ok, ms));
            break;
          }
          case 'reinstate':
            p.quarantined = false; setReplicas(p, 'warm');
            emit('agent', `agent: reinstate ${e.poolId} — verified by consecutive in-SLO probes`, 'ok');
            break;
          case 'escalate':
            emit('agent', `agent: ESCALATE ${e.poolId} to on-call — fault beyond allowlist; ` +
              'quarantine held, probe cadence slowed 5× (friction #10 lesson)', 'warn');
            break;
          case 'resolve': {
            const id = incIds.get(e.poolId);
            if (id) {
              const inc = incidents.resolve(id);
              incIds.delete(e.poolId);
              emit('agent', `incident ${id} resolved — MTTR ${inc.mttr_s}s`, 'ok');
              if (drill && drill.pool === e.poolId) finishDrill(inc);
            }
            break;
          }
          case 'observe':
            emit('agent', e.note, 'warn');
            break;
        }
      }
    }

    // ---- drills ---------------------------------------------------------------
    function runDrill() {
      if (drill) return false;
      const p = byId['baseten-dedicated'];
      p.chaos = { latency_ms: 600, until: t + 12 };
      drill = { kind: 'drill', pool: p.id, startedAt: t, evidence: null,
                contract: { breached: 0, total: 0 } };
      emit('chaos', `chaos: +600ms TTFT injected on ${p.id} for 12s (drill) — friction #10/#17 latency class`, 'warn');
      return true;
    }

    /* The rigged drill: an operator takes every OTHER operated pool out
       first, then degrades the last one. The agent must refuse to
       quarantine it and say why — the guard is the demo. */
    function runRiggedDrill() {
      if (drill) return false;
      const others = pools.filter(p => operated(p) && p.id !== 'baseten-dedicated');
      for (const p of others) {
        p.quarantined = true; setReplicas(p, 'quarantined');
        emit('chaos', `operator: quarantined ${p.id} (rigged drill setup)`, 'warn');
      }
      const p = byId['baseten-dedicated'];
      p.chaos = { latency_ms: 600, until: t + 12 };
      drill = { kind: 'rigged', pool: p.id, startedAt: t,
                riggedPools: others.map(o => o.id), evidence: null,
                contract: { breached: 0, total: 0 } };
      emit('chaos', `chaos: +600ms TTFT injected on ${p.id} — it is now the LAST healthy operated pool`, 'warn');
      return true;
    }

    function finishDrill(inc) {
      const guards = [];
      if (drill.kind === 'rigged') {
        guards.push('last-healthy-pool guard HELD: quarantine withheld, service never orphaned');
      } else {
        guards.push('quarantine issued only with healthy capacity remaining');
      }
      guards.push('sticky quarantine: healthz alone never reinstates — verified probes did');
      guards.push('monitor-only pools untouched (structural, unit-tested)');
      /* The contract verdict: degraded route requests during the incident,
         priced against the monthly error budget the goodput target implies.
         "Graceful" means the incident spent seconds of budget, not the
         contract. */
      const c = drill.contract;
      const contractRps = routes.filter(r => contractRoutes.has(r.id))
        .reduce((a, r) => a + r.rps, 0);
      const monthlyBudget = Math.max(1,
        Math.round((1 - slo.goodput_target) * contractRps * 86400 * 30));
      drill.evidence = {
        policy: `slo-policy: ttft_p99 ≤ ${overrides.slo_ttft_ms}ms, breach threshold ` +
          `${Math.round(agent.config.breach_rate_threshold * 100)}% over ≥${agent.config.min_samples} samples`,
        did: inc.actions.map(a => a.text),
        mttr_s: inc.mttr_s,
        guards,
        allowlist: agentMod.ALLOWLIST,
        kind: drill.kind,
        contract: {
          breached: c.breached, total: c.total,
          goodput_during: c.total ? Math.round((1 - c.breached / c.total) * 1000) / 10 : null,
          budget_pct: Math.round(c.breached / monthlyBudget * 10000) / 100,
          monthly_budget: monthlyBudget,
          intact: c.breached < monthlyBudget,
        },
      };
      // put the rigged pools back
      if (drill.riggedPools) {
        for (const id of drill.riggedPools) {
          byId[id].quarantined = false; setReplicas(byId[id], 'warm');
          emit('chaos', `operator: reinstated ${id} (drill teardown)`, 'info');
        }
      }
      drill.done = true;
    }

    // ---- release --------------------------------------------------------------
    function startRollout() {
      if (release && release.state === releaseMod.IN_PROGRESS) return false;
      release = releaseMod.createRelease({
        stable: 'qwen3-8b-awq @ v1', candidate: 'qwen3-8b-awq @ v2',
        mode: releaseDefaults.mode, steps: [...overrides.canary_steps],
        warmup: releaseDefaults.warmup, drain: releaseDefaults.drain,
      });
      regression = false; drainPending = null;
      const ev = release.start();
      releaseGateAt = t + 6;
      emit('release', `rollout started: ${ev.candidate} at ${ev.weight}% (canary), candidate pre-warmed`, 'ok');
      return true;
    }

    function injectRegression() {
      if (!release || release.state !== releaseMod.IN_PROGRESS) return false;
      regression = true;
      emit('chaos', 'chaos: +400ms TTFT regression injected into the CANDIDATE build', 'warn');
      return true;
    }

    function tickRelease() {
      if (!release || release.state !== releaseMod.IN_PROGRESS || t < releaseGateAt) {
        if (drainPending && drainPending.count > 0) {
          drainPending.count -= 1;   // one in-flight generation finishes per tick
          if (drainPending.count === 0) {
            emit('release', `drain complete on ${drainPending.what} — 0 in-flight, replica stopped ` +
              '(zero-drop: canStopDrained)', 'ok');
          }
        }
        return;
      }
      const p = byId['baseten-dedicated'];
      const base = effectiveTtft(p) * (0.9 + rand() * 0.3);
      const candTtft = base + (regression ? 400 : 0);
      const gate = policies.release.rollouts.default.probe.max_ms;
      const ok = candTtft <= gate;
      const ev = release.advance(ok);
      releaseGateAt = t + 6;
      if (ev.action === 'rollback') {
        emit('release', `probe FAILED at step ${release.stepIndex >= 0 ? release.steps[release.stepIndex] : 0}% ` +
          `(candidate ttft ${Math.round(candTtft)}ms > ${gate}ms) — AUTO-ROLLBACK, candidate weight 0%`, 'warn');
        drainPending = { what: 'candidate', count: 4 };
      } else if (ev.action === 'complete') {
        emit('release', `rollout complete — candidate at 100%, draining stable without cutting in-flight`, 'ok');
        drainPending = { what: 'stable', count: 5 };
      } else if (ev.action === 'advance') {
        emit('release', `probe passed (candidate ttft ${Math.round(candTtft)}ms ≤ ${gate}ms) — ` +
          `advance to ${ev.weight}%`, 'ok');
      }
    }

    // ---- migration -------------------------------------------------------------
    function startMigration(direction = 'in') {
      if (migration && !migration.finished) return false;
      migrationDir = direction;
      // IN (the headline): the monitored external route comes onto Baseten.
      // OUT (the no-lock-in proof): the Baseten-resident route leaves. Same
      // machine, direction swapped.
      const [route, source, target] = direction === 'in'
        ? ['voice-agent', 'competitor-cloud', 'baseten-dedicated']
        : ['voice-prod', 'baseten-dedicated', 'competitor-cloud'];
      migration = migrationMod.createMigration({
        route, source, target,
        slo: { ttft_p99_ms: overrides.slo_ttft_ms, tpot_p99_ms: slo.tpot_p99_ms },
        requiredSamples: 40,
      });
      emit('migration', `certified migration started: shadow ${migration.route} from ` +
        `${source} onto ${target} (mirrored traffic, responses discarded)`, 'ok');
      return true;
    }

    function tickMigration() {
      if (!migration || migration.finished) return;
      if (migration.stage === 'shadow') {
        const src = byId[migration.source], tgt = byId[migration.target];
        const n = 3 + Math.floor(rand() * 3);
        // the certify cohort is measured under a controlled mirror (the real
        // run benched a quiescent pool — migrate.py's lesson: a mirror storm
        // inflates the tail), so pairs use tight jitter, not live-tail jitter
        const tight = () => 0.85 + rand() * 0.35;
        for (let i = 0; i < n; i++) {
          migration.feed({
            srcTtft: effectiveTtft(src) * tight(),
            tgtTtft: effectiveTtft(tgt) * tight(),
            srcTpot: src.tpot_ms * (0.85 + rand() * 0.4),
            tgtTpot: tgt.tpot_ms * (0.85 + rand() * 0.4),
            parityOk: rand() < 0.985,
          });
          sample(tgt, 'shadow:' + migration.route);
        }
      } else if (migration.stage === 'certify') {
        const cert = migration.certify();
        emit('migration', `certify: parity ${(cert.quality.parity * 100).toFixed(1)}% ` +
          `(gate ${(cert.quality.gate * 100).toFixed(0)}%), target p99 TTFT ` +
          `${Math.round(cert.deltas.ttft_p99_ms.target)}ms vs gate ${cert.slo.gate_ttft_ms}ms → ${cert.verdict}`,
          cert.verdict === migrationMod.PROMOTE_ELIGIBLE ? 'ok' : 'warn');
      } else if (migration.stage === 'promote') {
        migration.promote();
        const r = routes.find(r => r.id === migration.route);
        if (r) r.pool = migration.target;
        emit('migration', migration.detail, 'ok');
      }
    }

    function rollbackMigration() {
      if (!migration || !migration.rollbackArmed) return false;
      migration.rollback();
      const r = routes.find(r => r.id === migration.route);
      if (r) r.pool = migration.source;
      emit('migration', migration.detail, 'ok');
      return true;
    }

    // ---- hero metrics ------------------------------------------------------------
    function heroMetrics() {
      const all = pools.filter(operated).flatMap(p => p.window);
      const ttfts = all.map(s => s.ttft), tpots = all.map(s => s.tpot);
      // the MEASURED chip on the blend is earned: only pools whose price
      // traces to a committed file participate; simulated pools would
      // poison the provenance (they still show their own labeled figures)
      const perPool = pools.filter(p => operated(p) && p.source === 'measured')
        .map(p => ({ usd_per_mtok: p.usd_per_mtok, tokens: p.served_tokens }));
      return {
        goodput: all.length ? costs.goodput(all.filter(s => s.slo_met).length, all.length) : null,
        ttft_p99_ms: costs.percentile(ttfts, 99),
        tpot_p99_ms: costs.percentile(tpots, 99),
        usd_per_mtok: costs.blendedUsdPerMtok(perPool),
        mttr_agent_s: incidents.mttrMedian(true),
        samples: all.length,
      };
    }

    function pushSparks() {
      const h = heroMetrics();
      const push = (k, v) => { if (v != null) { sparks[k].push(v); if (sparks[k].length > 48) sparks[k].shift(); } };
      push('goodput', h.goodput); push('ttft', h.ttft_p99_ms);
      push('tpot', h.tpot_p99_ms); push('cost', h.usd_per_mtok);
    }

    // ---- main tick ------------------------------------------------------------
    function tick(dt = 1) {
      t += dt;
      // chaos expiry
      for (const p of pools) if (p.chaos && t >= p.chaos.until) {
        p.chaos = null;
        emit('chaos', `chaos cleared on ${p.id}`, 'info');
      }
      trimWindows();
      // route traffic lands on the pool that ACTUALLY serves it: the declared
      // pool, or the failover target while the declared pool is out. Traffic
      // movement is an event — the operator watches it, never infers it.
      for (const r of routes) {
        const eff = effectivePoolId(r);
        if (lastServing[r.id] && lastServing[r.id] !== eff) {
          if (eff !== r.pool) {
            emit('failover', `failover: ${r.id} → ${eff} (${r.pool} out of rotation) — ` +
              'per failover-policy spill_order, SLO held', 'warn');
          } else {
            emit('failover', `recovery: ${r.id} back on ${r.pool}`, 'ok');
          }
        }
        lastServing[r.id] = eff;
        const p = byId[eff];
        if (!p) continue;
        const n = Math.max(1, Math.round(r.rps * dt * (0.7 + rand() * 0.6)));
        for (let i = 0; i < n; i++) sample(p, r.id);
      }
      // internal workload arrivals through the placement scorer
      const arrivals = rand() < 0.75 ? 1 : 2;
      for (let i = 0; i < arrivals; i++) {
        placeWorkload({ id: `wl-${seq}-${i}`, region: 'us-east-1' });
      }
      // the monitor speaks: a periodic scored summary in the feed
      if (t % 12 === 0 && pools.some(p => p.window.length)) {
        const line = pools.filter(p => p.window.length).map(p => {
          const p99 = costs.percentile(p.window.map(s => s.ttft), 99);
          return `${p.id.replace('baseten-', 'bt-')} ${Math.round(p99)}ms ${p99 <= overrides.slo_ttft_ms ? '✓' : '✗'}`;
        }).join(' · ');
        emit('monitor', `monitor: p99 TTFT vs ${overrides.slo_ttft_ms}ms gate — ${line}`, 'info');
      }
      // agent
      const { sigs, healthy } = signals();
      execute(agent.step(t, sigs, healthy));
      // machines
      tickRelease();
      tickMigration();
      pushSparks();
      return t;
    }

    // ---- views -----------------------------------------------------------------
    function poolsView() {
      return pools.map(p => {
        const ttfts = p.window.map(s => s.ttft), tpots = p.window.map(s => s.tpot);
        return {
          id: p.id, provider: p.provider, instance: p.instance, region: p.region,
          control: p.control, tags: p.tags || [], hazards: p.hazards || [],
          compliance_regimes: p.compliance_regimes || [],
          replicas: p.replicas.map(r => r.state),
          quarantined: p.quarantined, healthy: p.healthy,
          serving: routes.some(r => effectivePoolId(r) === p.id),
          rps: Math.round(p.window.filter(s => s.t > t - 5).length / 5 * 10) / 10,
          usd_per_mtok: p.usd_per_mtok, usd_hr: p.usd_hr,
          cold_start_s: p.cold_start_s, cold_mitigation: p.cold_mitigation,
          sla: p.sla,
          ttft_p99_ms: costs.percentile(ttfts, 99),
          tpot_p99_ms: costs.percentile(tpots, 99),
          samples: p.window.length,
          source: p.source, provenance: p.provenance,
          chaos: !!(p.chaos && t < p.chaos.until),
        };
      });
    }

    let stickyWinback = [];
    function winbackView() {
      const routeViews = routes.map(r => ({ id: r.id, pool: r.pool }));
      const poolViews = pools.map(p => ({
        id: p.id, control: p.control, usd_per_mtok: p.usd_per_mtok,
        dedicated: p.usd_hr != null,      // metered dedicated capacity
        samples: p.window.length,          // evidence = observed traffic
        ttft_p99_ms: costs.percentile(p.window.map(s => s.ttft), 99) ?? p.ttft_ms,
      }));
      const fresh = migrationMod.winback(routeViews, poolViews,
        { ttft_p99_ms: overrides.slo_ttft_ms });
      /* A recommendation is a directive to the operator — it must not
         flicker with per-window jitter. Once fired it stays until the route
         actually moves (or no longer lives on the external pool). */
      if (fresh.length) stickyWinback = fresh;
      else stickyWinback = stickyWinback.filter(w =>
        routes.some(r => r.id === w.route && r.pool === w.from));
      return stickyWinback;
    }

    return {
      // clock + determinism surface
      tick,
      get t() { return t; },
      // views
      heroMetrics, poolsView, winbackView,
      /* The cross-cloud SLO monitor's own status: what it scores, against
         which gates, and the per-cloud verdict — the agent made visible. */
      monitorView: () => ({
        gate_ttft_ms: overrides.slo_ttft_ms,
        gate_tpot_ms: slo.tpot_p99_ms,
        window_s: WINDOW_S,
        pools: pools.map(p => {
          const ttft = costs.percentile(p.window.map(s => s.ttft), 99);
          const tpot = costs.percentile(p.window.map(s => s.tpot), 99);
          return { id: p.id, control: p.control, samples: p.window.length,
                   ttft_p99_ms: ttft,
                   ok: ttft == null ? null
                     : ttft <= overrides.slo_ttft_ms && tpot <= slo.tpot_p99_ms };
        }),
      }),
      routesServingView: () => routes.map(r => ({
        id: r.id, declared: r.pool, serving: effectivePoolId(r),
      })),
      eventsView: () => [...events],
      sparksView: () => ({ goodput: [...sparks.goodput], ttft: [...sparks.ttft],
                           tpot: [...sparks.tpot], cost: [...sparks.cost] }),
      incidentsView: () => incidents.snapshot(),
      routesView: () => routes.map(r => ({ ...r })),
      agentView: () => ({ allowlist: agentMod.ALLOWLIST, config: agent.config }),
      releaseView: () => release && {
        stable: release.stable, candidate: release.candidate, mode: release.mode,
        steps: release.steps, stepIndex: release.stepIndex, state: release.state,
        weight: release.candidateWeight(), history: [...release.history],
        drain: drainPending ? { ...drainPending } : null, regression,
      },
      migrationView: () => migration && {
        route: migration.route, source: migration.source, target: migration.target,
        stage: migration.stage, detail: migration.detail, mirrored: migration.mirrored,
        required: migration.requiredSamples, cert: migration.cert,
        verdict: migration.verdict, serving: migration.serving,
        rollbackArmed: migration.rollbackArmed, finished: migration.finished,
        direction: migrationDir,
      },
      drillView: () => drill && { ...drill },
      // controls
      runDrill, runRiggedDrill, startRollout, injectRegression,
      startMigration, rollbackMigration,
      /* Operator controls exist only on OPERATED pools — a human's buttons,
         separate from the agent's allowlist. Monitor-only pools refuse even
         the operator (the UI never renders the button; this is the backstop). */
      operatorQuarantine: id => {
        const p = byId[id];
        if (!p || !operated(p) || p.quarantined) return false;
        p.quarantined = true; setReplicas(p, 'quarantined');
        emit('operator', `operator: quarantined ${id} (manual)`, 'warn');
        return true;
      },
      operatorReinstate: id => {
        const p = byId[id];
        if (!p || !operated(p) || !p.quarantined) return false;
        p.quarantined = false; setReplicas(p, 'warm');
        emit('operator', `operator: reinstated ${id} (manual)`, 'info');
        return true;
      },
      clearDrill: () => { drill = null; },
      overrides,
      setOverride: (k, v) => { overrides[k] = v; emit('policy', `policy override: ${k} → ${JSON.stringify(v)}`, 'info'); },
    };
  }

  return { createEngine, WINDOW_S };
});
