/* recorded.js — the measured operating points the simulator anchors on, plus
   the verbatim replay episode. Every `source: 'measured'` value traces to a
   committed file in data/recorded/ (see PROVENANCE.md); `provenance` is the
   tooltip text. `source: 'simulated'` values are honest fabrications the
   seeded simulator jitters around — labeled everywhere they appear.

   Embedded as JS (not fetched) so the console works from file://. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.RP = root.RP || {}; root.RP.recorded = factory(); }
})(globalThis, function () {
  'use strict';

  /* Pool performance profiles — merged over policies/placement-policy.yaml
     by the engine. usd_per_mtok follows the one rule: pool $/hr ÷ measured
     tokens/sec (costs.js); Model APIs are per-token billed, so theirs is the
     billed cost from the sweep CSV. */
  const profiles = {
    'baseten-dedicated': {
      replicas: 4,
      ttft_ms: 330, tpot_ms: 34,
      usd_hr: 0.9024,             // T4x8x32 $0.01504/min, docs.baseten.co published price
      usd_per_mtok: 8.53,         // 0.9024/hr ÷ 29.4 tok/s measured (TPOT 34 ms/tok)
      cold_start_s: 148, cold_mitigation: 'BDN weights cache (360s before — friction #17)',
      sla: '99.9% (published)',
      source: 'measured',
      provenance: 'Live T4x8x32 vLLM Qwen3-8B-AWQ deployment (baseten-mvp deploy/baseten/vllm-truss, ' +
        'deployment w52yvzr): warm TTFT ~330ms, TPOT ~34ms/tok from committed deployment logs ' +
        '(FRICTION_LOG #15); cold start 148.2s post-BDN vs 360.4s (#17); $/Mtok = published ' +
        '$0.9024/hr ÷ measured 29.4 tok/s.',
    },
    'baseten-model-api': {
      replicas: 4,
      ttft_ms: 299, tpot_ms: 6.3,
      usd_hr: null,               // per-token billed — no instance to meter
      usd_per_mtok: 2.78,
      cold_start_s: 0, cold_mitigation: 'always-on shared capacity',
      sla: '99.9% (published)',
      source: 'measured',
      provenance: 'Model API sweep, glm-4.7 rows (data/recorded/model_api_sweep_20260703-*.csv): ' +
        'p50 TTFT 299ms, billed $2.78/Mtok, 159 tok/s. Hazard: 28/40 requests 429d at ~1.3 rps ' +
        'with no Retry-After (rate_limit_glm47_20260702-183916.csv, friction #10).',
    },
    'competitor-cloud': {
      replicas: 2,
      ttft_ms: 280, tpot_ms: 33,
      usd_hr: 1.10,               // representative A10G on-demand rate
      usd_per_mtok: 10.19,        // 1.10/hr ÷ 30 tok/s assumed at the same model family
      cold_start_s: 4, cold_mitigation: 'GPU memory snapshot (provider-published)',
      sla: '99.95% (published)',
      source: 'simulated',
      provenance: 'SIMULATED — representative of a competitor dedicated cloud (no recorded ' +
        'bench CSV in data/recorded/ yet). Record real numbers with bench/ against any ' +
        'OpenAI-compatible endpoint and drop the CSV in data/recorded/ — the pool then ' +
        'reads MEASURED.',
    },
    'baseten-dedicated-2': {
      replicas: 4,
      ttft_ms: 330, tpot_ms: 34,
      usd_hr: 0.9024,             // same T4x8x32 SKU as cluster 1
      usd_per_mtok: 8.53,
      cold_start_s: 148, cold_mitigation: 'BDN weights cache (same config as cluster 1)',
      sla: '99.9% (published)',
      source: 'measured',
      provenance: 'Second cluster of the same deployment config as baseten-dedicated (T4x8x32, ' +
        'vLLM, Qwen3-8B-AWQ, BDN weights): operating point from the same committed deployment ' +
        'logs (FRICTION_LOG #15/#17); $/Mtok = published $0.9024/hr ÷ measured 29.4 tok/s. ' +
        'Declared as the failover cluster in failover-policy.yaml.',
    },
  };

  /* The recorded MTTR story (chaos_drills.csv): agent-on runs cluster at
     8.1–9.2s; every agent-off drill row is resolved=False — the manual
     baseline never recovered inside the drill window. */
  const mttr = {
    agent_median_s: 8.1,
    agent_range_s: [8.1, 9.2],
    headline_range_s: [8.8, 9.2],
    agent_off: 'never recovered (all agent-off drill rows: resolved=False)',
    provenance: 'data/recorded/chaos_drills.csv — 65 drill runs, 2026-07-02→04; ' +
      '48 agent-on runs with measured MTTR, incl. 8.8s and 9.2s; agent-off rows never resolved.',
  };

  /* Verbatim replay episode — ep-inc-0001-1783126701 from
     data/recorded/episodes-live.jsonl (recorded 2026-07-04, MTTR 8.8s). */
  const replayEpisode = {
    episode_id: 'ep-inc-0001-1783126701',
    recorded_at: '2026-07-04T00:58:29Z',
    source: 'live-incident',
    policy: { breach_rate_threshold: 0.5, min_samples: 4, probe_interval_s: 3.0,
              probes_to_reinstate: 2, cooldown_s: 30.0, probe_slo_ms: 500.0,
              escalate_after_failures: 5 },
    context: { model: 'qwen3-8b', pool: 'baseten-l4' },
    incident: {
      id: 'INC-0001',
      title: 'baseten-l4 breaching serving SLO — 55% of recent requests',
      agent: true,
      phase_ms: { detect: 0.0, diagnose: 0.0, resolve: 8777.6 },
    },
    trajectory: [
      'detected SLO breach rate 55% over 11 requests on baseten-l4',
      'quarantined baseten-l4; traffic spills to healthy pools',
      'probe passed (374ms)',
      'probe passed (383ms)',
      'reinstated baseten-l4 — 2 consecutive probes within SLO',
    ],
    probes: [{ ok: true, ms: 374 }, { ok: true, ms: 383 }],
    outcome: { resolved: true, mttr_s: 8.8, quarantined: true, escalated: false,
               probes_run: 2, probes_failed: 0 },
  };

  /* SLO/SLA comparison strip + the friction #18 lag pair. */
  const comparison = {
    note: 'measured cells trace to data/recorded/; published cells are the provider’s page',
    lag_pair: {
      first_read: 'counter 0.0, all-null histogram ~35s after traffic',
      second_read: 'counter 7.0, full quantiles ~2min later',
      provenance: 'data/recorded/live_mcp_metrics_summary_20260704-191352.json vs _191613.json (friction #18)',
    },
  };

  return { profiles, mttr, replayEpisode, comparison };
});
