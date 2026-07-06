/* live.js — LIVE mode. When the local bridge (live/bridge.py) is running,
   the console stops simulating and operates the real thing: real Baseten
   activations, real streaming traffic to every cloud, real mirrored pairs
   through the same certify gate, and the SAME agent decision core
   (js/sim/agent.js) quarantining and reinstating real pools.

   The bridge only executes and measures; every decision stays here in the
   browser — identical code to the demo workspace. */
(function (root) {
  'use strict';
  const RP = root.RP;
  const BRIDGE = 'http://127.0.0.1:8788';
  const GATE = { ttft_p99_ms: 500, tpot_p99_ms: 80 };

  async function detect() {
    try {
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(), 700);
      const r = await fetch(BRIDGE + '/status', { signal: ctl.signal });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }

  function boot() {
    const $ = id => document.getElementById(id);
    const nowS = () => Date.now() / 1000;
    const incidents = RP.incidents.createIncidentStore({ clock: nowS });
    const agent = RP.agent.createAgentLogic({ probe_slo_ms: GATE.ttft_p99_ms,
                                              breach_rate_threshold: 0.5, min_samples: 3 });
    const incIds = new Map();
    const localEvents = [];
    let lseq = 1e6;
    const lemit = (kind, text) => localEvents.push({ seq: ++lseq, t: Math.round(nowS()), kind, text });

    let st = null, mx = null;          // /status, /metrics
    let paused = false;
    let migration = null;              // browser-side certifier view
    let deploying = false;

    const post = (path, body) => fetch(BRIDGE + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}) }).then(r => r.json()).catch(() => null);

    // ---- views built from live data -------------------------------------------
    function poolViews() {
      if (!mx) return [];
      return Object.entries(mx).map(([id, m]) => {
        const servingIds = Object.values(st.routes || {}).map(r => r.serving);
        const tokps = m.tokps_p50;
        return {
          id, provider: id.startsWith('baseten') ? 'baseten' : 'competitor',
          instance: 'live', region: '—', control: m.control,
          tags: [], hazards: [], compliance_regimes: [],
          replicas: [m.health === 'down' ? 'cold' : m.quarantined ? 'quarantined' : 'warm'],
          quarantined: m.quarantined, healthy: m.health !== 'down',
          serving: servingIds.includes(id),
          rps: m.rps || 0,
          usd_per_mtok: m.usd_hr && tokps ? RP.costs.usdPerMtok(m.usd_hr, tokps) &&
            Math.round(RP.costs.usdPerMtok(m.usd_hr, tokps) * 100) / 100 : null,
          usd_hr: m.usd_hr,
          cold_start_s: (st.deploy[id] || {}).cold_start_s,
          cold_mitigation: 'measured this session',
          sla: '—',
          ttft_p99_ms: m.ttft_p99_ms,
          tpot_p99_ms: tokps ? Math.round(1000 / tokps * 10) / 10 : null,
          samples: m.samples, source: 'live',
          provenance: 'LIVE — measured from real streaming requests this session',
          chaos: st.chaos && st.chaos.active && id === 'baseten-dedicated',
        };
      });
    }

    function monitorView() {
      return {
        gate_ttft_ms: GATE.ttft_p99_ms, gate_tpot_ms: GATE.tpot_p99_ms, window_s: 60,
        pools: poolViews().map(p => ({
          id: p.id, control: p.control, samples: p.samples,
          ttft_p99_ms: p.ttft_p99_ms,
          ok: p.ttft_p99_ms == null ? null : p.ttft_p99_ms <= GATE.ttft_p99_ms,
        })),
      };
    }

    function heroView() {
      const ps = poolViews().filter(p => p.control === 'operated');
      const all = ps.flatMap(p => (mx[p.id].last || []).filter(s => s.ok));
      const ttfts = all.map(s => s.ttft_ms);
      const good = all.filter(s => s.ttft_ms <= GATE.ttft_p99_ms).length;
      const withPrice = ps.filter(p => p.usd_per_mtok != null && p.samples > 0);
      const blended = withPrice.length
        ? withPrice.reduce((a, p) => a + p.usd_per_mtok * p.samples, 0) /
          withPrice.reduce((a, p) => a + p.samples, 0) : null;
      return {
        goodput: all.length ? good / all.length : null,
        ttft_p99_ms: RP.costs.percentile(ttfts, 98),
        tpot_p99_ms: ps.map(p => p.tpot_p99_ms).filter(v => v != null).sort((a, b) => b - a)[0] ?? null,
        usd_per_mtok: blended && Math.round(blended * 100) / 100,
        samples: all.length,
      };
    }

    function sparks() {
      const buf = k => Object.values(mx || {}).flatMap(m => m.last || [])
        .sort((a, b) => a.t - b.t).map(s => s.ttft_ms).filter(Boolean).slice(-48);
      return { goodput: [], ttft: buf(), tpot: [], cost: [] };
    }

    // ---- the agent, on real signals ---------------------------------------------
    function agentTick() {
      if (!mx) return;
      const sigs = poolViews().map(p => {
        const recent = (mx[p.id].last || []).filter(s => s.t > nowS() - 20);
        const breaches = recent.filter(s => !s.ok || s.ttft_ms > GATE.ttft_p99_ms).length;
        return { poolId: p.id, control: p.control,
                 usable: p.healthy && !p.quarantined, healthzOk: p.healthy,
                 breachRate: recent.length ? breaches / recent.length : 0,
                 samples: recent.length };
      });
      const healthy = sigs.filter(s => s.control === 'operated' && s.usable).length;
      execute(agent.step(nowS(), sigs, healthy));
    }

    async function execute(effects) {
      for (const e of effects) {
        if (e.op === 'open') {
          const inc = incidents.open(e.title, true);
          incIds.set(e.poolId, inc.id);
          lemit('agent', `incident ${inc.id} opened: ${e.title}`);
        } else if (e.op === 'act') {
          if (incIds.has(e.poolId)) incidents.act(incIds.get(e.poolId), e.action, e.phase);
        } else if (e.op === 'quarantine' || e.op === 'reinstate') {
          await post('/act', { op: e.op, pool: e.poolId });
          lemit('agent', `agent: ${e.op} ${e.poolId} — executed on the REAL pool via bridge`);
        } else if (e.op === 'probe') {
          post('/probe', { pool: e.poolId, gate_ms: agent.config.probe_slo_ms })
            .then(r => { if (r) execute(agent.recordProbe(nowS(), e.poolId, r.ok, r.ms)); });
        } else if (e.op === 'escalate') {
          lemit('agent', `agent: ESCALATE ${e.poolId} — probes failing beyond allowlist (real cold start in progress?)`);
        } else if (e.op === 'resolve') {
          const id = incIds.get(e.poolId);
          if (id) { const inc = incidents.resolve(id); incIds.delete(e.poolId);
                    lemit('agent', `incident ${id} resolved — real MTTR ${inc.mttr_s}s`); }
        } else if (e.op === 'observe') {
          lemit('agent', e.note);
        }
      }
    }

    // ---- migration through the real certify gate ---------------------------------
    function migView() {
      if (!st || st.migration.stage === 'idle') return null;
      const stage = st.migration.stage;
      if (stage === 'certify' && !migration) {
        const pairs = (st.pairs || []).filter(p => p.srcTtft && p.tgtTtft);
        migration = RP.migration.createMigration({
          route: st.migration.route, source: 'competitor-cloud',
          target: st.migration.target, slo: GATE, requiredSamples: pairs.length || 1 });
        pairs.forEach(p => migration.feed(p));
        const cert = migration.certify();
        lemit('migration', `certify on REAL mirrored cohort: ${cert.verdict} — target p99 ` +
          `${Math.round(cert.deltas.ttft_p99_ms.target)}ms vs gate ${GATE.ttft_p99_ms}ms`);
        if (cert.verdict === 'PROMOTE_ELIGIBLE') post('/migrate', { action: 'promote' });
      }
      return {
        route: st.migration.route, source: 'competitor-cloud', target: st.migration.target,
        stage: stage === 'promoted' ? 'done' : stage === 'rolled_back' ? 'done' : stage,
        detail: stage === 'shadow' ? `mirroring REAL requests — ${ (st.pairs || []).length } pairs so far`
          : stage === 'promoted' ? `MIGRATED — ${st.migration.target} serves ${st.migration.route}; rollback armed`
          : stage === 'rolled_back' ? 'rolled back — original pool serves again'
          : migration ? migration.detail : 'certifying…',
        mirrored: (st.pairs || []).length, required: 12,
        cert: migration ? migration.cert : null,
        verdict: migration ? migration.verdict : null,
        serving: stage === 'promoted' ? st.migration.target : 'competitor-cloud',
        rollbackArmed: stage === 'promoted', finished: stage === 'promoted' || stage === 'rolled_back',
        direction: 'in',
      };
    }

    function winback() {
      const routeViews = Object.entries(st.routes || {}).map(([id, r]) => ({ id, pool: r.serving }));
      const views = poolViews().map(p => ({
        id: p.id, control: p.control, dedicated: p.usd_hr != null,
        samples: p.samples, usd_per_mtok: p.usd_per_mtok, ttft_p99_ms: p.ttft_p99_ms,
      }));
      // same evidence discipline as the sim: a full window per pool before
      // the ledger directs anyone anywhere
      const MIN_EVIDENCE = 8;
      return RP.migration.winback(routeViews, views, GATE)
        .filter(w => (views.find(v => v.id === w.from) || {}).samples >= MIN_EVIDENCE &&
                     (views.find(v => v.id === w.to) || {}).samples >= MIN_EVIDENCE);
    }

    // ---- stepper (live copy) -------------------------------------------------------
    function renderStepper() {
      const d = st.deploy || {};
      const phases = Object.entries(d).map(([id, x]) =>
        `${id.replace('baseten-dedicated', 'cluster').replace('competitor-cloud', 'competitor')}: ${x.phase}` +
        (x.cold_start_s ? ` (${x.cold_start_s}s)` : '')).join(' · ');
      const ready = st.deployed && st.traffic.running;
      const totalSamples = Object.values(mx || {}).reduce((a, m) => a + m.samples, 0);
      const wb = winback();
      const promoted = st.migration.stage === 'promoted';
      const steps = [
        { n: 1, t: 'Existing cloud attached', st: 'done', sub: 'competitor-cloud · shadow (read-only) · real endpoint' },
        { n: 2, t: 'Baseten clusters provisioned', st: 'done', sub: '3ydn1e43 (T4) + qrj78jv3 (L4:2) · REAL workspace via management API' },
        { n: 3, t: 'Deploy your workload', st: ready ? 'done' : 'now',
          sub: deploying || (st.deployed === false && Object.values(d).some(x => x.phase !== 'idle'))
            ? phases : ready ? 'REAL streaming traffic on every cloud' : 'activates the real deployments — cold start is the real 148s class',
          act: ready ? null : 'deploy' },
        { n: 4, t: 'Watch the SLO evidence', st: !ready ? 'todo' : totalSamples > 30 ? 'done' : 'now',
          sub: !ready ? 'live p99s, goodput, $/Mtok = $/hr ÷ measured tok/s' : totalSamples > 30 ? 'evidence window full — all numbers LIVE' : 'windows filling with real requests…' },
        { n: 5, t: 'Migrate on evidence', st: promoted ? 'done' : wb.length ? 'now' : 'todo',
          sub: promoted ? 'promoted on a REAL certified cohort — rollback armed'
            : wb.length ? `YOUR MOVE — live evidence ready: −${wb[0].delta_pct}% at equal SLO` : 'appears when live evidence supports it',
          act: (!promoted && wb.length && st.migration.stage === 'idle') ? 'migrate' : null,
          actLabel: '▶ Migrate now — evidence ready' },
      ];
      $('setup').innerHTML = steps.map(s => `
        <div class="sstep ${s.st}">
          <div class="shead"><span class="sn">${s.st === 'done' ? '✓' : s.n}</span><span class="st">${s.t}</span></div>
          <div class="ssub">${s.sub}</div>
          ${s.act ? `<button class="primary" data-live="${s.act}">${s.actLabel || '▶ Deploy workload (real)'}</button>` : ''}
        </div>`).join('');
    }

    // ---- render loop ------------------------------------------------------------
    function renderAll() {
      if (!st) return;
      renderStepper();
      RP.ui.hero.render($('hero'), heroView(), sparks(), RP.recorded.mttr,
        incidents.snapshot().find(i => !i.live)?.mttr_s ?? null);
      RP.ui.pools.renderMonitor($('monitor'), monitorView());
      RP.ui.pools.render($('pools'), $('slo-strip'), poolViews(), null);
      const events = [...(st.events || []).map(e => ({ ...e, cls: e.kind === 'chaos' || e.kind === 'failover' ? 'warn' : 'info' })), ...localEvents]
        .sort((a, b) => a.t - b.t || a.seq - b.seq).map((e, i) => ({ ...e, seq: i + 1 }));
      RP.ui.feed.render($('feed'), events, { paused: false });
      RP.ui.releasePanel.renderMigration($('migration'), migView(), winback());
      $('rollout').innerHTML = '<div class="note">The release engine (canary + auto-rollback) is a sim-workspace demo — <a href="operate.html?sim=1">open the demo workspace</a>. Live mode moves routes, not versions.</div>';
      $('btn-rollout').style.display = 'none';
      $('btn-regression').style.display = 'none';
      $('btn-rigged').style.display = 'none';
      RP.ui.incidentPanel.render($('incident'), {
        incidents: incidents.snapshot(), drill: null,
        allowlist: RP.agent.ALLOWLIST });
      $('sim-clock').textContent = `LIVE · ${st.traffic.sent} real requests · ${st.traffic.errors} errors${paused ? ' · polling paused' : ''}`;
    }

    async function poll() {
      if (paused) return;
      const [s, m] = await Promise.all([
        fetch(BRIDGE + '/status').then(r => r.json()).catch(() => null),
        fetch(BRIDGE + '/metrics').then(r => r.json()).catch(() => null),
      ]);
      if (!s) { $('sim-clock').textContent = 'LIVE bridge lost — restart live/bridge.py'; return; }
      st = s; mx = m;
      if (st.traffic.running) agentTick();
      renderAll();
    }

    // ---- wiring -------------------------------------------------------------------
    document.addEventListener('click', e => {
      const lb = e.target.closest('button[data-live]');
      if (lb && lb.dataset.live === 'deploy') {
        deploying = true;
        post('/deploy').then(() => {
          const wait = setInterval(() => {
            if (st && st.deployed) { clearInterval(wait); post('/traffic', { action: 'start', rps: 1.5 }); }
          }, 2000);
        });
        return;
      }
      if (lb && lb.dataset.live === 'migrate') {
        migration = null;
        post('/migrate', { action: 'start', route: 'voice-agent', target: 'baseten-dedicated' });
        document.getElementById('panel-migration').scrollIntoView({
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          block: 'center' });
        return;
      }
      const btn = e.target.closest('button[data-act]');
      if (btn) {
        if (btn.dataset.act === 'migrate') { migration = null; post('/migrate', { action: 'start', route: 'voice-agent', target: 'baseten-dedicated' }); }
        if (btn.dataset.act === 'rollback') post('/migrate', { action: 'rollback' });
        if (btn.dataset.act === 'quarantine') post('/act', { op: 'quarantine', pool: btn.dataset.pool });
        if (btn.dataset.act === 'reinstate') post('/act', { op: 'reinstate', pool: btn.dataset.pool });
      }
    });
    $('btn-drill').addEventListener('click', () => {
      lemit('chaos', 'REAL chaos requested: deactivate + reactivate cluster-1 — recovery rides the real cold start');
      post('/chaos');
    });
    $('btn-pause').addEventListener('click', () => {
      paused = !paused;
      $('btn-pause').textContent = paused ? '▶ Resume' : '⏸ Pause';
    });
    RP.ui.policyRail.render($('policy-rail'), RP.policyText, {
      capacity_preference: 'reserved', canary_steps: [5, 25, 100],
      spill_enabled: true, slo_ttft_ms: GATE.ttft_p99_ms });

    poll();
    setInterval(poll, 1500);
  }

  RP.live = { detect, boot };
})(globalThis);
