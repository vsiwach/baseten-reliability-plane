/* console.js — boots the engine and wires the panels. This file owns the
   clock and the buttons; every decision stays in js/sim.

   The console opens in a NAMED state (the setup stepper): existing cloud
   attached in shadow, Baseten cluster provisioned — and nothing is measured
   until the operator deploys the workload. The clock only ticks after
   deploy, so every number on screen is a consequence of an action the
   operator took. */
(function (root) {
  'use strict';
  const RP = root.RP;
  const qs = new URLSearchParams(location.search);
  const SEED = Number(qs.get('seed')) || 42;

  // ---- boot ------------------------------------------------------------------
  const policies = {
    slo: RP.yaml.parse(RP.policyText.slo),
    release: RP.yaml.parse(RP.policyText.release),
    placement: RP.yaml.parse(RP.policyText.placement),
    failover: RP.yaml.parse(RP.policyText.failover),
  };
  const profiles = JSON.parse(JSON.stringify(RP.recorded.profiles));
  const engine = RP.engine.createEngine({ seed: SEED, policies, profiles });

  const $ = id => document.getElementById(id);
  let paused = false;
  let deployed = false;      // step 3 of the setup — nothing ticks before it
  let feedPaused = false;

  // ---- render loop -------------------------------------------------------------
  function renderAll() {
    RP.ui.setup.render($('setup'), {
      deployed,
      samples: engine.heroMetrics().samples || 0,
      winback: engine.winbackView(),
      migration: engine.migrationView(),
    });
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
    });
    $('sim-clock').textContent = deployed
      ? `t+${engine.t}s${paused ? ' · PAUSED' : ''}`
      : 'workload not deployed';
  }

  function tick() {
    if (!paused && deployed) {
      engine.tick(1);
      renderAll();
    }
  }

  // ---- wiring --------------------------------------------------------------------
  $('btn-pause').addEventListener('click', () => {
    paused = !paused;
    $('btn-pause').textContent = paused ? '▶ Resume' : '⏸ Pause';
    renderAll();
  });
  $('btn-drill').addEventListener('click', () => { engine.clearDrill(); engine.runDrill(); renderAll(); });
  $('btn-rigged').addEventListener('click', () => { engine.clearDrill(); engine.runRiggedDrill(); renderAll(); });
  $('btn-rollout').addEventListener('click', () => { engine.startRollout(); renderAll(); });
  $('btn-regression').addEventListener('click', () => { engine.injectRegression(); renderAll(); });

  // setup stepper, migration + pool controls are re-rendered nodes → delegate
  document.addEventListener('click', e => {
    const setupBtn = e.target.closest('button[data-setup]');
    if (setupBtn && setupBtn.dataset.setup === 'deploy') {
      deployed = true;
      renderAll();
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'migrate') engine.startMigration('in');
    if (btn.dataset.act === 'migrate-out') engine.startMigration('out');
    if (btn.dataset.act === 'rollback') engine.rollbackMigration();
    if (btn.dataset.act === 'quarantine') engine.operatorQuarantine(btn.dataset.pool);
    if (btn.dataset.act === 'reinstate') engine.operatorReinstate(btn.dataset.pool);
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
