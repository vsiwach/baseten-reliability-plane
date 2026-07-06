/* incidents.js — the incident timeline store, ported from ai-native-pipeline
   router_app/incidents.py. Incidents move detect → diagnose → resolve with a
   per-phase clock; MTTR is open→resolve. Clock injected (seconds), no I/O. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.RP = root.RP || {}; root.RP.incidents = factory(); }
})(globalThis, function () {
  'use strict';

  function createIncidentStore({ clock, emit, maxIncidents = 200 } = {}) {
    const now = clock || (() => Date.now() / 1000);
    const fire = emit || (() => {});
    let incidents = [];
    let seq = 0;

    function find(id) { return incidents.find(i => i.id === id) || null; }

    function open(title, agent = true) {
      seq += 1;
      const t = now();
      const inc = {
        id: `INC-${String(seq).padStart(4, '0')}`,
        title, ts: t,
        phase_ms: { detect: 0, diagnose: 0, resolve: 0 },
        mttr_s: 0, agent, actions: [], live: true,
        _opened: t, _phaseStarted: t, _phase: 'detect',
      };
      incidents.push(inc);
      if (incidents.length > maxIncidents) incidents = incidents.slice(-maxIncidents);
      fire('incident_open', { id: inc.id, title, agent });
      return inc;
    }

    /* Append an action; optionally advance the phase, closing out the
       elapsed time of the current phase. */
    function act(incidentId, action, phase = null) {
      const inc = find(incidentId);
      if (!inc || !inc.live) return null;
      const t = now();
      inc.actions.push({ t: t - inc._opened, text: action, phase: phase || inc._phase });
      if (phase && phase !== inc._phase) {
        inc.phase_ms[inc._phase] = Math.round(
          (inc.phase_ms[inc._phase] + (t - inc._phaseStarted) * 1000) * 10) / 10;
        inc._phase = phase;
        inc._phaseStarted = t;
      }
      fire('incident_action', { id: incidentId, action, phase });
      return inc;
    }

    function resolve(incidentId) {
      const inc = find(incidentId);
      if (!inc || !inc.live) return null;
      const t = now();
      inc.phase_ms[inc._phase] = Math.round(
        (inc.phase_ms[inc._phase] + (t - inc._phaseStarted) * 1000) * 10) / 10;
      inc.mttr_s = Math.round((t - inc._opened) * 10) / 10;
      inc.live = false;
      fire('incident_resolved', { id: incidentId, mttr_s: inc.mttr_s });
      return inc;
    }

    /* Newest first; live incidents report elapsed time so the MTTR
       stopwatch can count up. */
    function snapshot() {
      const t = now();
      return [...incidents].reverse().map(inc => {
        const pub = {
          id: inc.id, title: inc.title, ts: inc.ts, agent: inc.agent,
          actions: [...inc.actions], live: inc.live,
          phase_ms: { ...inc.phase_ms }, mttr_s: inc.mttr_s,
        };
        if (inc.live) {
          pub.mttr_s = Math.round((t - inc._opened) * 10) / 10;
          pub.phase_ms[inc._phase] += (t - inc._phaseStarted) * 1000;
        }
        return pub;
      });
    }

    function mttrMedian(agent) {
      const vals = incidents
        .filter(i => !i.live && i.agent === agent)
        .map(i => i.mttr_s).sort((a, b) => a - b);
      if (!vals.length) return null;
      const mid = Math.floor(vals.length / 2);
      return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
    }

    return { open, act, resolve, snapshot, mttrMedian };
  }

  return { createIncidentStore };
});
