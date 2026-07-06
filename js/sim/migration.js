/* migration.js — certified migration: shadow → certify → promote, with
   rollback held for the route's life (F1.2). Ported from the
   ai-native-pipeline certified-migration machinery (router_app/migrate.py +
   shadow/certify), pointed at the acquisition story: the headline run
   migrates a monitored external route ONTO baseten-dedicated.

   Deliberately direction-agnostic: createMigration({source, target}) runs
   the same state machine either way. Migrate-out is one click too — that
   reversibility is why attaching your endpoints is safe. Pure, no I/O:
   the engine feeds mirrored sample pairs; certify() judges them against
   the SLO policy and refuses honestly when the gate fails. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./costs.js'));
  else { root.RP = root.RP || {}; root.RP.migration = factory(root.RP.costs); }
})(globalThis, function (costs) {
  'use strict';

  const STAGES = ['shadow', 'certify', 'promote', 'done'];
  const PROMOTE_ELIGIBLE = 'PROMOTE_ELIGIBLE', HOLD = 'HOLD';

  function createMigration({ route, source, target, slo,
                             requiredSamples = 40, parityGate = 0.9 }) {
    const m = {
      route, source, target,
      stage: 'shadow',
      detail: `mirroring ${route} traffic from ${source} onto ${target} — responses discarded`,
      mirrored: 0,
      pairs: [],              // {srcTtft, tgtTtft, srcTpot, tgtTpot, parityOk}
      cert: null,
      verdict: null,
      serving: source,
      rollbackArmed: false,
      finished: false,
    };

    /* Shadow phase: every request is served by `source` (the client sees
       nothing change) and mirrored to `target`. */
    function feed(pair) {
      if (m.stage !== 'shadow') return false;
      m.pairs.push(pair);
      m.mirrored += 1;
      if (m.mirrored >= requiredSamples) {
        m.stage = 'certify';
        m.detail = `cohort full (${m.mirrored} mirrored) — scoring parity + SLO`;
      }
      return true;
    }

    /* Certify: side-by-side measured deltas on the mirrored cohort, judged
       against the SLO policy. Promotion happens ONLY on PROMOTE_ELIGIBLE —
       an automated run cannot skip the gate, it can only fail it. */
    function certify() {
      if (m.stage !== 'certify' || !m.pairs.length) return null;
      const p99 = arr => costs.percentile(arr, 99);
      const srcTtft = p99(m.pairs.map(p => p.srcTtft));
      const tgtTtft = p99(m.pairs.map(p => p.tgtTtft));
      const srcTpot = p99(m.pairs.map(p => p.srcTpot));
      const tgtTpot = p99(m.pairs.map(p => p.tgtTpot));
      const parity = m.pairs.filter(p => p.parityOk).length / m.pairs.length;
      const sloPass = tgtTtft <= slo.ttft_p99_ms && tgtTpot <= slo.tpot_p99_ms;
      const parityPass = parity >= parityGate;
      m.verdict = (sloPass && parityPass) ? PROMOTE_ELIGIBLE : HOLD;
      m.cert = {
        route: m.route, source: m.source, target: m.target,
        cohort: m.pairs.length,
        deltas: {
          ttft_p99_ms: { source: srcTtft, target: tgtTtft },
          tpot_p99_ms: { source: srcTpot, target: tgtTpot },
        },
        quality: { parity, gate: parityGate, pass: parityPass },
        slo: { gate_ttft_ms: slo.ttft_p99_ms, gate_tpot_ms: slo.tpot_p99_ms, pass: sloPass },
        verdict: m.verdict,
      };
      if (m.verdict === PROMOTE_ELIGIBLE) {
        m.stage = 'promote';
        m.detail = `certificate PASS — parity ${(parity * 100).toFixed(1)}% ≥ ${(parityGate * 100).toFixed(0)}%, ` +
                   `p99 TTFT ${Math.round(tgtTtft)}ms ≤ ${slo.ttft_p99_ms}ms — ready to move traffic`;
      } else {
        m.stage = 'done';
        m.finished = true;
        m.detail = `certificate HOLD — gate refused, ${m.route} stays on ${m.source}. ` +
                   'A refusal is the system working.';
      }
      return m.cert;
    }

    /* Promote: traffic moves; instant rollback stays armed for the route's
       life — not for a grace period. */
    function promote() {
      if (m.stage !== 'promote' || m.verdict !== PROMOTE_ELIGIBLE) return false;
      m.serving = m.target;
      m.rollbackArmed = true;
      m.stage = 'done';
      m.finished = true;
      m.detail = `MIGRATED — ${m.target} serves ${m.route}; rollback to ${m.source} armed for the route's life`;
      return true;
    }

    function rollback() {
      if (!m.rollbackArmed) return false;
      m.serving = m.source;
      m.rollbackArmed = false;
      m.stage = 'done';
      m.detail = `rolled back — ${m.source} serves ${m.route} again (one click, no drama)`;
      return true;
    }

    return {
      get route() { return m.route; },
      get source() { return m.source; },
      get target() { return m.target; },
      get stage() { return m.stage; },
      get detail() { return m.detail; },
      get mirrored() { return m.mirrored; },
      get cert() { return m.cert; },
      get verdict() { return m.verdict; },
      get serving() { return m.serving; },
      get rollbackArmed() { return m.rollbackArmed; },
      get finished() { return m.finished; },
      requiredSamples,
      feed, certify, promote, rollback,
    };
  }

  /* The win-back scorer (F2.5): the route ledger continuously scores every
     monitored route against every eligible pool. A recommendation appears
     when an external route would hold its SLO at lower measured $/Mtok on an
     operated pool — from rerunnable measured evidence, never vibes. */
  function winback(routes, pools, slo) {
    const out = [];
    for (const r of routes) {
      const from = pools.find(p => p.id === r.pool);
      if (!from || from.control === 'operated') continue;
      for (const to of pools) {
        // targets are dedicated operated capacity only — serverless Model
        // APIs are the spill/failover target, not a migration destination
        if (to.control !== 'operated' || !to.dedicated ||
            to.usd_per_mtok == null || from.usd_per_mtok == null) continue;
        const holdsSlo = to.ttft_p99_ms != null && to.ttft_p99_ms <= slo.ttft_p99_ms;
        if (holdsSlo && to.usd_per_mtok < from.usd_per_mtok) {
          out.push({
            route: r.id, from: from.id, to: to.id,
            usd_from: from.usd_per_mtok, usd_to: to.usd_per_mtok,
            delta_pct: Math.round((1 - to.usd_per_mtok / from.usd_per_mtok) * 100),
            ttft_to: to.ttft_p99_ms, slo_ttft: slo.ttft_p99_ms,
          });
        }
      }
    }
    return out.sort((a, b) => b.delta_pct - a.delta_pct);
  }

  return { STAGES, PROMOTE_ELIGIBLE, HOLD, createMigration, winback };
});
