/* hero.js — the five-tile hero strip (F0.4): Goodput at SLO, p99 TTFT,
   p99 TPOT, blended $/Mtok, MTTR. Renderer only. */
(function (root) {
  'use strict';
  const { fmt, chipped, sparkline } = root.RP.ui.format;

  function render(el, hero, sparks, mttrRecorded, sessionMttr) {
    const tiles = [
      {
        label: 'Goodput at SLO',
        html: chipped(fmt.pct(hero.goodput), 'simulated',
          'Fraction of live sim requests meeting BOTH SLO gates in the rolling window. Simulated traffic; the rule is costs.js goodput(), same as the recorded drills.'),
        spark: sparkline(sparks.goodput, { lime: true }),
      },
      {
        label: 'p99 TTFT',
        html: chipped(fmt.ms(hero.ttft_p99_ms), 'simulated',
          'p99 time-to-first-token across operated pools, live sim window. Pool operating points anchor on measured values (see pool cards).'),
        spark: sparkline(sparks.ttft),
      },
      {
        label: 'p99 TPOT',
        html: chipped(fmt.msTok(hero.tpot_p99_ms), 'simulated',
          'p99 per-token cadence across operated pools, live sim window.'),
        spark: sparkline(sparks.tpot),
      },
      {
        label: 'blended $/Mtok',
        html: chipped(fmt.usd(hero.usd_per_mtok), 'measured',
          'Blend of MEASURED pools only (T4x8x32: published $0.9024/hr ÷ measured 29.4 tok/s = $8.53; Model API: billed $2.78 from sweep CSVs), weighted by sim traffic mix. Simulated-price pools are excluded so this chip stays honest.'),
        spark: sparkline(sparks.cost),
      },
      {
        label: 'MTTR (median)',
        html: chipped(fmt.s(mttrRecorded.agent_median_s), 'measured', mttrRecorded.provenance) +
          `<div class="sub">agent off: <b>${mttrRecorded.agent_off.split(' (')[0]}</b></div>` +
          (sessionMttr != null
            ? `<div class="sub">this workspace: ${fmt.s(sessionMttr)}</div>`
            : '<div class="sub">this workspace: test remediation →</div>'),
        spark: '',
        accent: true,
      },
    ];
    el.innerHTML = tiles.map(t => `
      <div class="tile ${t.accent ? 'accent' : ''}">
        <div class="lbl">${t.label}</div>
        <div class="val">${t.html}</div>
        ${t.spark}
      </div>`).join('');
  }

  root.RP.ui.hero = { render };
})(globalThis);
