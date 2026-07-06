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
    const c = ev.contract;
    const contractLine = c && c.total ? `
        <div class="mono evline"><span>contract</span>
          <span><b class="${c.intact ? 'mttr' : ''}">SLO CONTRACT ${c.intact ? 'INTACT ✓' : 'BREACHED'}</b> —
          ${c.breached} degraded of ${c.total} customer requests in the incident window
          (goodput ${c.goodput_during}% during; failover held the route)
          · ${c.budget_pct}% of the month's error budget (${c.monthly_budget.toLocaleString()} req at ${'99%'} goodput) spent</span></div>` : '';
    return `
      <div class="evidence card">
        <h3>EVIDENCE — what policy required, what the agent did</h3>
        <div class="mono evline"><span>policy</span> ${esc(ev.policy)}</div>
        <div class="mono evline"><span>MTTR</span> <b class="mttr">${fmt.s(ev.mttr_s)}</b> <span class="note">(recorded live runs: 8.8–9.2s <span class="chip measured" data-tip="data/recorded/chaos_drills.csv — 48 agent-on live drill runs, 2026-07-02→04." tabindex="0">MEASURED</span>)</span></div>
        ${contractLine}
        <div class="mono evline"><span>guards</span><ul>${ev.guards.map(g => `<li>${esc(g)}</li>`).join('')}</ul></div>
        ${allowlistHtml(ev.allowlist)}
      </div>`;
  }

  function render(el, { incidents, drill, allowlist }) {
    const inc = incidents[0];
    if (!inc) {
      el.innerHTML = `
        <div class="note">No incidents in this workspace. The monitor watches every cloud; remediation
        acts only on Baseten pools. "Test remediation" injects real chaos — the agent detects the SLO
        breach from live samples (never just healthz), quarantines, verifies with streaming-TTFT
        probes, reinstates on 2 passes. "Test the guard" proves it refuses when acting would be worse.
        Recorded live runs of this loop measured MTTR 8.8–9.2s.</div>
        ${allowlistHtml(allowlist)}`;
      return;
    }
    const watch = inc.live
      ? `<span class="stopwatch mono" aria-live="polite">⏱ ${inc.mttr_s.toFixed(1)}s</span>`
      : `<span class="stopwatch mono done">MTTR ${fmt.s(inc.mttr_s)}</span>`;
    const liveContract = inc.live && drill && drill.contract
      ? `<div class="mono note" style="margin-bottom:8px;color:var(--lime)">SLO contract: INTACT — error-budget burn so far: ${drill.contract.breached} degraded request${drill.contract.breached === 1 ? '' : 's'} (failover holds the route while the agent works)</div>`
      : '';
    el.innerHTML = `
      <div class="inc-head">
        <div><span class="mono">${esc(inc.id)}</span> ${esc(inc.title)}</div>
        ${watch}
      </div>
      ${liveContract}
      ${timeline(inc.actions)}
      ${drill && drill.done && drill.evidence ? evidenceCard(drill.evidence) : allowlistHtml(allowlist)}`;
  }

  root.RP.ui.incidentPanel = { render };
})(globalThis);
