/* format.js — shared formatting + tiny render helpers for the panels.
   Renderers only: nothing in js/ui decides anything. */
(function (root) {
  'use strict';
  const NO_DATA = '<span class="chip nodata" data-tip="No samples in the window yet — this console never renders zeros pretending to be data. Deploy the workload (step 3) and the window fills.">awaiting workload</span>';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const fmt = {
    ms: v => v == null ? null : `${Math.round(v)}ms`,
    msTok: v => v == null ? null : `${v.toFixed(1)}ms/tok`,
    usd: v => v == null ? null : `$${v.toFixed(2)}`,
    pct: v => v == null ? null : `${(v * 100).toFixed(1)}%`,
    s: v => v == null ? null : `${v.toFixed(1)}s`,
  };

  /* A value with its provenance chip. Chips mark only the claims worth
     selling: MEASURED (traces to a committed recording — hover for the
     source) and PUBLISHED (the provider's own page). Live console figures
     render plain — they are the workload's telemetry, not a citation.
     Null values render the no-data chip, never a zero. */
  function chipped(value, kind, tip) {
    if (value == null) return NO_DATA;
    if (kind === 'simulated') {
      return `<span class="v">${esc(value)}</span>`;
    }
    const label = { measured: 'MEASURED', published: 'PUBLISHED' }[kind];
    return `<span class="v">${esc(value)}</span> <span class="chip ${kind === 'published' ? 'published' : kind}" data-tip="${esc(tip || '')}" tabindex="0">${label}</span>`;
  }

  function sparkline(values, { width = 96, height = 26, lime = false } = {}) {
    if (!values || values.length < 2) return '';
    const min = Math.min(...values), max = Math.max(...values);
    const span = max - min || 1;
    const pts = values.map((v, i) =>
      `${(i / (values.length - 1) * width).toFixed(1)},${(height - 3 - (v - min) / span * (height - 6)).toFixed(1)}`);
    return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"><polyline class="${lime ? 'lime' : ''}" points="${pts.join(' ')}"/></svg>`;
  }

  function dots(replicas) {
    return `<span class="dots">${replicas.map(r =>
      `<span class="dot ${esc(r)}" title="${esc(r)}"></span>`).join('')}</span>`;
  }

  root.RP = root.RP || {};
  root.RP.ui = root.RP.ui || {};
  root.RP.ui.format = { esc, fmt, chipped, sparkline, dots, NO_DATA };
})(globalThis);
