/* pools.js — the multi-cloud pool grid + the SLO/SLA comparison strip.
   The trust ladder is rendered here: OPERATED pools carry the full control
   surface; MONITOR-ONLY pools have every control affordance ABSENT (not
   disabled) except "Migrate route". Renderer only — the agent's refusal to
   act on monitor-only pools is enforced in js/sim/agent.js and unit-tested. */
(function (root) {
  'use strict';
  const { esc, fmt, chipped, dots } = root.RP.ui.format;

  const LADDER_TIP = 'The trust ladder: observe (read-only telemetry on any cloud) → migrate (certified, reversible) → declare (policy objects on Baseten pools) → operate (agents enforce them). Control features apply only to Baseten-side pools.';

  function card(p) {
    const external = p.control !== 'operated';
    const badge = external
      ? `<span class="badge monitor" data-tip="${esc(LADDER_TIP)}" tabindex="0">MONITOR-ONLY</span>`
      : `<span class="badge operated" data-tip="${esc(LADDER_TIP)}" tabindex="0">OPERATED</span>`;
    const border = p.quarantined ? 'quarantined' : (p.serving ? 'serving' : '');
    const kind = p.source === 'measured' ? 'measured' : 'simulated';
    const hazard = p.hazards.includes('rate-limit-coupling')
      ? `<div class="hazard" data-tip="28/40 requests 429d at ~1.3 rps with no Retry-After (data/recorded/rate_limit_glm47_*.csv). Per-model-per-workspace limits couple this pool with every other consumer of the same model — spilled traffic and recovery probes spend the SAME quota." tabindex="0">⚠ placement risk: rate-limit coupling (friction #10)</div>` : '';
    const controls = external
      ? '<button class="mini" data-act="migrate">Migrate route →</button>'
      : `<button class="mini" data-act="quarantine" data-pool="${esc(p.id)}">Quarantine</button>
         <button class="mini" data-act="reinstate" data-pool="${esc(p.id)}">Reinstate</button>
         <span class="rev" data-tip="Certified migration is reversible by design — the same state machine runs in either direction; that's why attaching your endpoints is safe." tabindex="0">⇄ migrate out is one click too</span>`;
    return `
    <div class="pool card ${border}" data-pool="${esc(p.id)}">
      <div class="pool-head">
        <div>
          <div class="lbl">${esc(p.provider)} · ${esc(p.instance)} · ${esc(p.region)}${p.compliance_regimes.length ? ' · ' + esc(p.compliance_regimes.join('+').toUpperCase()) : ''}</div>
          <div class="name">${esc(p.id)}</div>
        </div>
        ${badge}
      </div>
      ${dots(p.replicas)}
      <div class="stats mono">
        <div><span>$/Mtok</span><span>${chipped(fmt.usd(p.usd_per_mtok), kind, p.provenance)}</span></div>
        <div><span>p99 TTFT (live)</span><span>${chipped(fmt.ms(p.ttft_p99_ms), 'simulated', 'Live sim window, anchored on the recorded operating point: ' + p.provenance)}</span></div>
        <div><span>p99 TPOT (live)</span><span>${chipped(fmt.msTok(p.tpot_p99_ms), 'simulated', 'Live sim window.')}</span></div>
        <div><span>cold start</span><span>${chipped(p.cold_start_s + 's', kind, 'Mitigation: ' + p.cold_mitigation + ' — ' + p.provenance)}</span></div>
      </div>
      ${hazard}
      <div class="pool-controls">${controls}</div>
      ${p.quarantined ? '<div class="qnote mono">QUARANTINED — sticky until verified probes pass</div>' : ''}
    </div>`;
  }

  function strip(pools, profiles) {
    const rows = pools.map(p => {
      const prof = profiles[p.id];
      const kind = p.source === 'measured' ? 'measured' : 'simulated';
      return `<tr>
        <td>${esc(p.id)}</td>
        <td class="num">${chipped(fmt.ms(prof.ttft_ms) + ' warm', kind, prof.provenance)}</td>
        <td class="num">${chipped(fmt.msTok(prof.tpot_ms), kind, prof.provenance)}</td>
        <td class="num">${chipped(prof.cold_start_s + 's', kind, prof.cold_mitigation + ' — ' + prof.provenance)}</td>
        <td class="num">${chipped(fmt.usd(prof.usd_per_mtok), kind, prof.provenance)}</td>
        <td class="num">${chipped(prof.sla.replace(' (published)', ''), 'published', 'Provider-published SLA, not a measurement. Baseten: baseten.co/service-level-agreement (99.9% monthly, capacity-scoped). Modal: modal.com SLA page.')}</td>
      </tr>`;
    }).join('');
    return `<div class="table-scroll"><table class="data">
      <thead><tr><th>pool</th><th>ttft (warm)</th><th>tpot</th><th>cold start</th><th>$/Mtok</th><th>published SLA</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <div class="note" style="margin-top:8px">Every cell carries provenance: MEASURED traces to a file in <span class="mono">data/recorded/</span>, SIMULATED is the seeded sim, PUBLISHED is the provider's page. Contrast is the point — measured p99s vs published SLAs is the gap this plane productizes.</div>`;
  }

  function render(el, stripEl, pools, profiles) {
    el.innerHTML = pools.map(card).join('');
    stripEl.innerHTML = strip(pools, profiles);
  }

  root.RP.ui.pools = { render };
})(globalThis);
