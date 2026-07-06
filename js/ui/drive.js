/* drive.js — the guided drive strip: the console's five actions in the order
   a skeptical buyer comes to trust them (the conversion ladder: trust the
   agent → trust the guard → trust the release engine → move a route → check
   the receipts). Renderer only; console.js owns state + wiring. */
(function (root) {
  'use strict';
  const { esc } = root.RP.ui.format;

  const STEPS = [
    { id: 'drill', n: 1, title: 'Run a drill', target: '#panel-incidents',
      what: 'Chaos hits a pool. The agent detects the SLO breach from live samples, quarantines, verifies with probes, reinstates — MTTR on a stopwatch.' },
    { id: 'rigged', n: 2, title: 'Try to break the guard', target: '#panel-incidents',
      what: 'Every other pool is taken out first. The agent must refuse to quarantine the last one — and say why.' },
    { id: 'rollout', n: 3, title: 'Ship a bad canary', target: '#panel-release',
      what: 'A rollout starts with a regression injected. The probe gate fails it, auto-rolls-back, drains with zero drops.' },
    { id: 'migrate', n: 4, title: 'Migrate the route', target: '#panel-migration',
      what: 'The win-back evidence is already on screen: shadow off Modal onto Baseten, certify parity, promote. Rollback stays armed.' },
    { id: 'replay', n: 5, title: 'Check the receipts', target: '#panel-incidents',
      what: 'Everything above was simulated and labeled. This replays a real recorded incident — MTTR 8.8s, measured.' },
  ];

  function render(el, state) {
    el.innerHTML = STEPS.map(s => {
      const st = state[s.id] || 'todo';   // todo | running | done
      return `
      <div class="dstep ${st}" data-step="${s.id}">
        <div class="dhead">
          <span class="dn">${st === 'done' ? '✓' : s.n}</span>
          <button class="dact ${st === 'todo' ? 'primary' : ''}" data-drive="${esc(s.id)}">
            ${st === 'running' ? '… running' : st === 'done' ? 'Run again' : s.title}
          </button>
        </div>
        <div class="dwhat">${esc(s.what)}</div>
      </div>`;
    }).join('');
  }

  root.RP.ui.drive = { render, STEPS };
})(globalThis);
