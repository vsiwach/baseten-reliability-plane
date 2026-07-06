/* format.js — shared formatting + tiny render helpers for the panels.
   Renderers only: nothing in js/ui decides anything. */
(function (root) {
  'use strict';
  const NO_DATA = '<span class="chip nodata" data-tip="Empty window: the source has no samples yet. This console never renders zeros pretending to be data (friction #18: metrics lag arrives as silent nulls).">no data yet (lag)</span>';

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

  /* A value with its provenance chip — the honest-numbers rule in one
     helper. kind: 'measured' | 'simulated' | 'published'. Null values render
     the no-data chip, never a zero. */
  function chipped(value, kind, tip) {
    if (value == null) return NO_DATA;
    const label = { measured: 'MEASURED', simulated: 'SIMULATED', published: 'PUBLISHED' }[kind];
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
