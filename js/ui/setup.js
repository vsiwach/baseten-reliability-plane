/* setup.js — the "your setup" stepper: the console's narrative state. It
   tells the operator exactly where they are in the journey the landing page
   promised: attached → provisioned → deploy workload → watch evidence →
   migrate on evidence. Renderer only. */
(function (root) {
  'use strict';

  function render(el, { deployed, samples, winback, migration }) {
    const migrated = migration && migration.finished && migration.verdict === 'PROMOTE_ELIGIBLE'
      && migration.serving === migration.target;
    const steps = [
      { n: 1, title: 'Existing cloud attached', state: 'done',
        sub: 'modal-dedicated · shadow (read-only) — via the one-prompt onboarding' },
      { n: 2, title: 'Baseten cluster provisioned', state: 'done',
        sub: 'baseten-dedicated · T4x8x32 · qwen3-8b-awq loaded' },
      { n: 3, title: 'Deploy your workload', state: deployed ? 'done' : 'now',
        sub: deployed ? 'chat-prod + voice-agent serving — traffic flowing to both clouds'
                      : 'nothing is measured until your traffic flows',
        action: deployed ? null : { id: 'deploy', label: '▶ Deploy workload' } },
      { n: 4, title: 'Watch the SLO evidence', state: !deployed ? 'todo' : (samples > 30 ? 'done' : 'now'),
        sub: !deployed ? 'per-cloud goodput, p99s, $/Mtok — against YOUR declared SLO'
          : samples > 30 ? 'evidence window full — the monitor is scoring both clouds'
          : 'windows filling…' },
      { n: 5, title: 'Migrate on evidence', state: migrated ? 'done' : (winback.length ? 'now' : 'todo'),
        sub: migrated ? `voice-agent now serves on baseten-dedicated — rollback armed`
          : winback.length ? `evidence ready: −${winback[0].delta_pct}% at equal SLO — see the win-back card`
          : 'appears when a route would hold its SLO cheaper on your Baseten cluster' },
    ];
    el.innerHTML = steps.map(s => `
      <div class="sstep ${s.state}">
        <div class="shead"><span class="sn">${s.state === 'done' ? '✓' : s.n}</span>
          <span class="st">${s.title}</span></div>
        <div class="ssub">${s.sub}</div>
        ${s.action ? `<button class="primary" data-setup="${s.action.id}">${s.action.label}</button>` : ''}
      </div>`).join('');
  }

  root.RP.ui.setup = { render };
})(globalThis);
