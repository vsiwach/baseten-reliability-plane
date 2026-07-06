/* feed.js — the placement/event feed (F0.2, F1.3, F1.4). Every row is a
   decision with its reason; failure classes come from the friction log,
   cited by number, never invented. Renderer only. */
(function (root) {
  'use strict';
  const { esc } = root.RP.ui.format;

  let lastSeq = 0;

  function render(el, events, { paused } = {}) {
    if (paused) return;
    const fresh = events.filter(e => e.seq > lastSeq);
    if (!fresh.length && el.children.length) return;
    lastSeq = events.length ? events[events.length - 1].seq : lastSeq;
    const rows = events.slice(-28).reverse().map(e => `
      <tr class="ev-${e.cls}">
        <td class="mono t">${e.t}s</td>
        <td class="mono k">${esc(e.kind)}</td>
        <td class="txt">${esc(e.text)}</td>
      </tr>`).join('');
    el.innerHTML = rows || '<tr><td colspan="3" class="note">no decisions recorded yet</td></tr>';
  }

  root.RP.ui.feed = { render };
})(globalThis);
