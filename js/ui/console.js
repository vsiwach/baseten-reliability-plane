/* console.js — boots the engine and wires the panels. This file owns the
   clock and the buttons; every decision stays in js/sim. */
(function (root) {
  'use strict';
  const RP = root.RP;
  const qs = new URLSearchParams(location.search);
  const SEED = Number(qs.get('seed')) || 42;
  const NODATA = qs.get('nodata');          // e.g. ?nodata=cost kills the $ source

  // ---- boot ------------------------------------------------------------------
  const policies = {
    slo: RP.yaml.parse(RP.policyText.slo),
    release: RP.yaml.parse(RP.policyText.release),
    placement: RP.yaml.parse(RP.policyText.placement),
    failover: RP.yaml.parse(RP.policyText.failover),
  };
  // honest-numbers demo hook: kill a data source and the UI must say
  // "no data yet", never zeros (acceptance checklist item)
  const profiles = JSON.parse(JSON.stringify(RP.recorded.profiles));
  if (NODATA === 'cost') {
    for (const p of Object.values(profiles)) p.usd_per_mtok = null;
  }
  const engine = RP.engine.createEngine({ seed: SEED, policies, profiles });

  const $ = id => document.getElementById(id);
  let paused = false;
  let replay = null;                        // {episode, elapsed}
  let feedPaused = false;

  // ---- render loop -------------------------------------------------------------
  function renderAll() {
    RP.ui.hero.render($('hero'), engine.heroMetrics(), engine.sparksView(),
      RP.recorded.mttr, engine.incidentsView().find(i => !i.live)?.mttr_s ?? null);
    RP.ui.pools.render($('pools'), $('slo-strip'), engine.poolsView(), profiles);
    RP.ui.feed.render($('feed'), engine.eventsView(), { paused: feedPaused });
    RP.ui.releasePanel.renderRollout($('rollout'), engine.releaseView(), engine.overrides.canary_steps);
    RP.ui.releasePanel.renderMigration($('migration'), engine.migrationView(), engine.winbackView());
    RP.ui.incidentPanel.render($('incident'), {
      incidents: engine.incidentsView(),
      drill: engine.drillView(),
      allowlist: engine.agentView().allowlist,
      replay,
    });
    $('sim-clock').textContent = `t+${engine.t}s · seed ${SEED}${paused ? ' · PAUSED' : ''}`;
  }

  function tick() {
    if (!paused) {
      engine.tick(1);
      if (replay) {
        replay.elapsed += 1;
        if (replay.elapsed > replay.episode.outcome.mttr_s + 4) replay = null;
      }
      renderAll();
    }
  }

  // ---- wiring --------------------------------------------------------------------
  $('btn-pause').addEventListener('click', () => {
    paused = !paused;
    $('btn-pause').textContent = paused ? '▶ Resume' : '⏸ Pause';
    renderAll();
  });
  $('btn-drill').addEventListener('click', () => { replay = null; engine.clearDrill(); engine.runDrill(); renderAll(); });
  $('btn-rigged').addEventListener('click', () => { replay = null; engine.clearDrill(); engine.runRiggedDrill(); renderAll(); });
  $('btn-replay').addEventListener('click', () => {
    replay = { episode: RP.recorded.replayEpisode, elapsed: 0 };
    renderAll();
  });
  $('btn-rollout').addEventListener('click', () => { engine.startRollout(); renderAll(); });
  $('btn-regression').addEventListener('click', () => { engine.injectRegression(); renderAll(); });

  // migration + pool controls are re-rendered nodes → delegate
  document.addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'migrate') engine.startMigration('in');
    if (act === 'rollback') engine.rollbackMigration();
    if (act === 'quarantine') engine.operatorQuarantine(btn.dataset.pool);
    if (act === 'reinstate') engine.operatorReinstate(btn.dataset.pool);
    renderAll();
  });

  // policy rail toggles (rendered once, so direct listeners are fine)
  RP.ui.policyRail.render($('policy-rail'), RP.policyText, engine.overrides);
  $('slo-slider').addEventListener('input', e => {
    engine.setOverride('slo_ttft_ms', Number(e.target.value));
    $('slo-val').textContent = e.target.value + 'ms';
  });
  document.querySelectorAll('input[name="steps"]').forEach(r =>
    r.addEventListener('change', e =>
      engine.setOverride('canary_steps', e.target.value.split(',').map(Number))));
  document.querySelectorAll('input[name="pref"]').forEach(r =>
    r.addEventListener('change', e =>
      engine.setOverride('capacity_preference', e.target.value)));
  $('spill-toggle').addEventListener('change', e =>
    engine.setOverride('spill_enabled', e.target.checked));
  $('feed-pause').addEventListener('click', () => {
    feedPaused = !feedPaused;
    $('feed-pause').textContent = feedPaused ? 'Resume' : 'Pause';
  });

  // SLA tier badge cycles the trust ladder
  const tiers = [
    ['MANAGED 99.9', 'Operated: Baseten pools under declared policy, agent-run remediation.'],
    ['DECLARED', 'Declared: your four policy objects are the contract; enforcement decisions are all visible below.'],
    ['OBSERVED', 'Observed: read-only telemetry on every cloud you run — where trust starts.'],
  ];
  let tierIdx = 0;
  $('sla-badge').addEventListener('click', () => {
    tierIdx = (tierIdx + 1) % tiers.length;
    $('sla-badge').textContent = tiers[tierIdx][0];
    $('sla-badge').dataset.tip = tiers[tierIdx][1] + ' Click to cycle the ladder: observe → migrate → declare → operate.';
  });

  renderAll();
  setInterval(tick, 700);
})(globalThis);
