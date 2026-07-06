/* incident-panel.js — incident timeline + MTTR stopwatch + evidence card
   (F2.1, F2.2), plus replay of a real recorded episode. The agent's closed
   allowlist is rendered here, visibly — authority you can read. */
(function (root) {
  'use strict';
  const { esc, fmt } = root.RP.ui.format;

  function allowlistHtml(allowlist) {
    return `<div class="allowlist mono" data-tip="The agent's entire authority. Adding an action means adding it here, visibly. No scale, no rollback, no config writes." tabindex="0">
      allowlist: ${allowlist.map(a => `<span class="al">${esc(a)}</span>`).join(' ')}</div>`;
  }

  function timeline(actions, openedAt) {
    if (!actions.length) return '';
    return `<table class="data tl">${actions.map(a => `
      <tr class="ph-${esc(a.phase)}">
        <td class="mono t">t+${a.t.toFixed(1)}s</td>
        <td class="mono ph">${esc(a.phase)}</td>
        <td>${esc(a.text)}</td>
      </tr>`).join('')}</table>`;
  }

  function evidenceCard(ev) {
    return `
      <div class="evidence card">
        <h3>EVIDENCE — what policy required, what the agent did</h3>
        <div class="mono evline"><span>policy</span> ${esc(ev.policy)}</div>
        <div class="mono evline"><span>MTTR</span> <b class="mttr">${fmt.s(ev.mttr_s)}</b> <span class="chip simulated" data-tip="This drill ran in the seeded simulator. The recorded live runs measured 8.8–9.2s (data/recorded/chaos_drills.csv).">SIMULATED</span></div>
        <div class="mono evline"><span>guards</span><ul>${ev.guards.map(g => `<li>${esc(g)}</li>`).join('')}</ul></div>
        ${allowlistHtml(ev.allowlist)}
      </div>`;
  }

  function render(el, { incidents, drill, allowlist, replay }) {
    if (replay) { renderReplay(el, replay, allowlist); return; }
    const inc = incidents[0];
    if (!inc) {
      el.innerHTML = `
        <div class="note">No incidents this session. "Run drill" injects real chaos (a friction-log latency class); the agent detects the SLO breach from live samples — never just healthz — quarantines, verifies with streaming-TTFT probes, reinstates on 2 passes, resolves. The rigged drill proves the guard.</div>
        ${allowlistHtml(allowlist)}`;
      return;
    }
    const watch = inc.live
      ? `<span class="stopwatch mono" aria-live="polite">⏱ ${inc.mttr_s.toFixed(1)}s</span>`
      : `<span class="stopwatch mono done">MTTR ${fmt.s(inc.mttr_s)}</span>`;
    el.innerHTML = `
      <div class="inc-head">
        <div><span class="mono">${esc(inc.id)}</span> ${esc(inc.title)}</div>
        ${watch}
      </div>
      ${timeline(inc.actions)}
      ${drill && drill.done && drill.evidence ? evidenceCard(drill.evidence) : allowlistHtml(allowlist)}`;
  }

  /* Replay a REAL recorded episode verbatim — trajectory rows appear on the
     recorded clock; every figure is the recorded one. */
  function renderReplay(el, rp, allowlist) {
    const { episode, elapsed } = rp;
    const total = episode.outcome.mttr_s;
    const times = [0, 0.2, 3.1, 6.1, total];   // detect, quarantine, probe, probe, reinstate
    const shown = episode.trajectory.filter((_, i) => times[i] <= elapsed);
    const live = elapsed < total;
    el.innerHTML = `
      <div class="inc-head">
        <div><span class="mono">${esc(episode.incident.id)}</span> ${esc(episode.incident.title)}
          <span class="chip measured" data-tip="Verbatim replay of episode ${esc(episode.episode_id)} from data/recorded/episodes-live.jsonl — a live incident on the real T4 deployment, recorded ${esc(episode.recorded_at)}. Policy, trajectory, probe latencies and MTTR are all recorded values." tabindex="0">MEASURED · recorded 2026-07-04</span></div>
        <span class="stopwatch mono ${live ? '' : 'done'}">${live ? '⏱ ' + elapsed.toFixed(1) + 's' : 'MTTR ' + fmt.s(total)}</span>
      </div>
      <table class="data tl">${shown.map((text, i) => `
        <tr class="ph-${i === 0 ? 'diagnose' : 'resolve'}">
          <td class="mono t">t+${times[i].toFixed(1)}s</td>
          <td class="mono ph">${i === 0 ? 'diagnose' : 'resolve'}</td>
          <td>${esc(text)}</td>
        </tr>`).join('')}</table>
      ${!live ? `
        <div class="evidence card">
          <h3>RECORDED OUTCOME</h3>
          <div class="mono evline"><span>MTTR</span> <b class="mttr">${fmt.s(total)}</b> <span class="chip measured" data-tip="episodes-live.jsonl, outcome.mttr_s">MEASURED</span></div>
          <div class="mono evline"><span>probes</span> ${episode.probes.map(p => `${p.ms}ms ${p.ok ? '✓' : '✗'}`).join(' · ')} (gate ${episode.policy.probe_slo_ms}ms)</div>
          <div class="mono evline"><span>policy</span> breach ≥${Math.round(episode.policy.breach_rate_threshold * 100)}% over ≥${episode.policy.min_samples} · reinstate after ${episode.policy.probes_to_reinstate} passes</div>
        </div>` : ''}
      ${allowlistHtml(allowlist)}`;
  }

  root.RP.ui.incidentPanel = { render };
})(globalThis);
