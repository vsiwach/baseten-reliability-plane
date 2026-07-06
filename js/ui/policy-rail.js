/* policy-rail.js — the four policy cards (F1.1–F1.5): YAML, a one-line human
   summary, and live toggles that change simulator behavior. Defaults-with-
   override is the message: cards start pre-filled and say so. */
(function (root) {
  'use strict';
  const { esc } = root.RP.ui.format;

  function yamlBlock(text) {
    return `<pre class="code">${esc(text).replace(/(^|\n)(\s*)([a-z_-]+):/g,
      (m, nl, sp, k) => `${nl}${sp}<span class="k">${k}</span>:`)}</pre>`;
  }

  function render(el, policyText, overrides) {
    const cards = [
      {
        name: 'slo-policy', title: 'SLO',
        summary: 'The targets everything else is judged against — probes, gates, goodput, the agent.',
        controls: `
          <label class="ctl">p99 TTFT gate <span class="mono" id="slo-val">${overrides.slo_ttft_ms}ms</span>
            <input type="range" id="slo-slider" min="300" max="800" step="50" value="${overrides.slo_ttft_ms}" aria-label="p99 TTFT gate in ms">
          </label>`,
      },
      {
        name: 'release-policy', title: 'Release',
        summary: 'Canary steps gated by probes; a failed probe auto-rolls-back; drain never cuts a generation.',
        controls: `
          <div class="ctl">canary steps
            <label><input type="radio" name="steps" value="5,25,100" ${overrides.canary_steps.join() === '5,25,100' ? 'checked' : ''}> <span class="mono">[5, 25, 100]</span></label>
            <label><input type="radio" name="steps" value="10,50,100" ${overrides.canary_steps.join() === '10,50,100' ? 'checked' : ''}> <span class="mono">[10, 50, 100]</span></label>
          </div>`,
      },
      {
        name: 'placement-policy', title: 'Placement',
        summary: 'Where work may land: region, compliance right-of-way, capacity preference.',
        controls: `
          <div class="ctl">capacity preference
            <label><input type="radio" name="pref" value="reserved" ${overrides.capacity_preference === 'reserved' ? 'checked' : ''}> reserved-first</label>
            <label><input type="radio" name="pref" value="cheapest" ${overrides.capacity_preference === 'cheapest' ? 'checked' : ''}> cheapest</label>
          </div>`,
      },
      {
        name: 'failover-policy', title: 'Failover',
        summary: 'A quarantined pool\'s traffic fails over in declared order: your second Baseten cluster first, then the Model API pool (priced with its real #10 hazard).',
        controls: `
          <label class="ctl"><input type="checkbox" id="spill-toggle" ${overrides.spill_enabled ? 'checked' : ''}> failover per <span class="mono">spill_order</span> (cluster-2 → model-api)</label>`,
      },
    ];
    el.innerHTML = cards.map(c => `
      <div class="card policy-card">
        <h3>${c.title} <span class="default-note">Baseten default — override below</span></h3>
        <div class="note">${c.summary}</div>
        ${yamlBlock(policyText[c.name.replace('-policy', '')])}
        ${c.controls}
      </div>`).join('');
  }

  root.RP.ui.policyRail = { render };
})(globalThis);
