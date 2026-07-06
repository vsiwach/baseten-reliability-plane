/* release-panel.js — rollout track + certified migration + the win-back
   card (F1.2, F2.5). Renderer only. */
(function (root) {
  'use strict';
  const { esc, fmt } = root.RP.ui.format;

  function segs(labels, activeIdx, state) {
    return `<div class="track">${labels.map((l, i) => {
      let cls = 'seg';
      if (state === 'failed' && i === activeIdx) cls += ' fail';
      else if (i < activeIdx || state === 'done') cls += ' done';
      else if (i === activeIdx) cls += ' active';
      return `<div class="${cls}">${esc(l)}</div>`;
    }).join('')}</div>`;
  }

  function renderRollout(el, r, steps) {
    if (!r) {
      el.innerHTML = `<div class="note">Canary per release-policy: <span class="mono">[${steps.join(', ')}]%</span>, each step gated by a TTFT probe; a failed probe auto-rolls-back; stable drains at zero in-flight.</div>`;
      return;
    }
    const labels = ['warmup', ...r.steps.map(s => s + '%')];
    let idx, state = null;
    if (r.state === 'rolled_back') { idx = r.stepIndex + 1; state = 'failed'; }
    else if (r.state === 'complete') { idx = labels.length; state = 'done'; }
    else idx = r.stepIndex + 1;
    const drain = r.drain
      ? `<div class="mono drain">drain ${esc(r.drain.what)}: ${r.drain.count} in-flight generation${r.drain.count === 1 ? '' : 's'} remaining ${r.drain.count === 0 ? '— replica stopped, zero drops' : '(never cut)'}</div>`
      : '';
    const status = r.state === 'rolled_back'
      ? `<span class="badge warn">ROLLED BACK — candidate weight 0%</span>`
      : r.state === 'complete'
        ? `<span class="badge live">COMPLETE — candidate at 100%</span>`
        : `<span class="badge idle">candidate at ${r.weight}%${r.regression ? ' · regression live' : ''}</span>`;
    el.innerHTML = `
      <div class="mono relhead">${esc(r.stable)} → ${esc(r.candidate)} (${esc(r.mode)}) ${status}</div>
      ${segs(labels, idx, state)}
      ${drain}`;
  }

  function renderMigration(el, m, winback) {
    const wb = winback.length ? winback[0] : null;
    const wbCard = wb ? `
      <div class="winback card" data-tip="">
        <h3>WIN-BACK — the ledger found a better home for a monitored route</h3>
        <div class="wbline"><span class="mono">${esc(wb.route)}</span> runs on
          <span class="mono">${esc(wb.from)}</span> today at <b>${fmt.usd(wb.usd_from)}/Mtok</b>.
          On <span class="mono">${esc(wb.to)}</span> it would hold your SLO
          (measured p99 TTFT ${Math.round(wb.ttft_to)}ms ≤ your ${wb.slo_ttft}ms gate)
          at <b>${fmt.usd(wb.usd_to)}/Mtok</b> — <b class="delta">−${wb.delta_pct}%, measured</b>.</div>
        <button class="primary" data-act="migrate">Shadow it now →</button>
        <div class="guardrail mono">recommendation from rerunnable measured evidence · your ledger, exportable · external legs zero markup</div>
      </div>` : '';
    if (!m) {
      el.innerHTML = wbCard + `
        <div class="note">Certified migration: shadow a monitored external route onto Baseten (mirrored traffic, responses discarded), certify parity + SLO side-by-side, promote only on a passing certificate — rollback held for the route's life. A refusal is the system working.</div>
        <button class="primary big" data-act="migrate">⚡ Migrate route</button>`;
      return;
    }
    const stageIdx = { shadow: 0, certify: 1, promote: 2, done: 3 }[m.stage];
    const failed = m.finished && m.verdict !== 'PROMOTE_ELIGIBLE';
    const cert = m.cert ? `
      <div class="cert mono">
        cohort <b>${m.cert.cohort} mirrored</b> · parity <b>${(m.cert.quality.parity * 100).toFixed(1)}% ${m.cert.quality.pass ? '≥' : '<'} ${(m.cert.quality.gate * 100).toFixed(0)}%</b><br>
        p99 TTFT <b>${Math.round(m.cert.deltas.ttft_p99_ms.source)}ms → ${Math.round(m.cert.deltas.ttft_p99_ms.target)}ms</b> (gate ${m.cert.slo.gate_ttft_ms}ms)
        · p99 TPOT <b>${m.cert.deltas.tpot_p99_ms.source.toFixed(1)} → ${m.cert.deltas.tpot_p99_ms.target.toFixed(1)}ms/tok</b>
        <span class="pass ${m.verdict === 'PROMOTE_ELIGIBLE' ? '' : 'hold'}">${m.verdict === 'PROMOTE_ELIGIBLE' ? 'PASS' : 'HOLD'}</span>
      </div>` : '';
    const rollback = m.rollbackArmed
      ? `<button class="danger" data-act="rollback">↶ Roll back to ${esc(m.source)}</button>
         <span class="note">rollback held for the route's life — not a grace period</span>` : '';
    const again = m.finished ? `<button data-act="migrate">⚡ Run again</button>` : '';
    el.innerHTML = wbCard + `
      <div class="mono relhead">${esc(m.route)}: ${esc(m.source)} → ${esc(m.target)}
        ${m.mirrored ? `· ${m.mirrored}/${m.required} mirrored` : ''}</div>
      ${segs(['SHADOW', 'CERTIFY', 'PROMOTE'], Math.min(stageIdx, 2), m.finished ? (failed ? 'failed' : 'done') : null)}
      <div class="note">${esc(m.detail)}</div>
      ${cert}
      <div class="migctl">${rollback} ${again}</div>`;
  }

  root.RP.ui.releasePanel = { renderRollout, renderMigration };
})(globalThis);
