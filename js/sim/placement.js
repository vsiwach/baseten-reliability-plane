/* placement.js — pure functions deciding WHICH capacity a workload may use,
   ported from ai-native-pipeline router_app/placement.py (F1.3, F1.4).

   Two rules:
   - A compliance-bound request may ONLY land on capacity tagged sensitive
     that satisfies its regime — it is DENIED ordinary capacity.
   - On sensitive capacity, compliance-bound work has RIGHT OF WAY: filler
     work is preempted; other compliant work queues.

   Every decision returns a human-readable `reason` — the placement feed is
   the product surface, not a log afterthought. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.RP = root.RP || {}; root.RP.placement = factory(); }
})(globalThis, function () {
  'use strict';

  const ADMIT = 'admit', PREEMPT = 'preempt', QUEUE = 'queue', DENY = 'deny';

  function sensitiveTags(policy) {
    return new Set((policy.compliance && policy.compliance.sensitive_capacity_tags) || []);
  }

  function isSensitive(pool, policy) {
    const tags = new Set(pool.tags || []);
    for (const t of sensitiveTags(policy)) if (tags.has(t)) return true;
    return false;
  }

  /* Pools this request may use, ordered by capacity_preference.
     request: {region?, compliance?}. preference override lets the console
     toggle reserved-first ↔ cheapest live. */
  function eligiblePools(request, policy, preferenceOverride) {
    const pools = policy.pools || [];
    const regime = request.compliance || null;
    const region = request.region || null;
    const pref = preferenceOverride ||
      (policy.capacity_preference && policy.capacity_preference[0]) || 'cheapest';

    let eligible = regime
      ? pools.filter(p => (p.compliance_regimes || []).includes(regime))
      : [...pools];

    const rank = p => {
      const outOfRegion = region && p.region !== region ? 1 : 0;
      const sensitiveLast = regime ? 0 : (isSensitive(p, policy) ? 1 : 0);
      let prefKey;
      if (pref === 'lowest_latency') prefKey = p.cold_start_s || 0;
      else if (pref === 'reserved') prefKey = ((p.tags || []).includes('reserved') ? 0 : 1) * 100 + (p.cost_rank || 0);
      else prefKey = p.cost_rank || 0;   // cheapest
      return [outOfRegion, sensitiveLast, prefKey];
    };
    return eligible.sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
      return a.id < b.id ? -1 : 1;
    });
  }

  /* How `request` is admitted to `pool` given current occupants
     (each {id, compliance}). Returns {action, victim?, reason}. */
  function planAdmission(request, pool, occupants, capacity, policy) {
    const regime = request.compliance || null;

    if (regime && !(pool.compliance_regimes || []).includes(regime)) {
      return { action: DENY, reason: 'pool does not satisfy regime' };
    }
    if (occupants.length < capacity) return { action: ADMIT, reason: 'capacity available' };

    if (regime && isSensitive(pool, policy)) {
      const filler = occupants.filter(o => !o.compliance);
      if (filler.length) {
        return { action: PREEMPT, victim: filler[0].id,
                 reason: 'compliance right-of-way over non-compliant work' };
      }
      return { action: QUEUE, reason: 'all occupants are compliance-bound' };
    }
    return { action: QUEUE, reason: 'pool at capacity' };
  }

  /* The feed line for a routed workload — every decision carries its policy
     trace: which constraints passed, which preference won, the live SLO
     check. Example:
     "route→baseten-dedicated: policy=us-east-1 ✓ hipaa n/a, reserved-first,
      ttft_p99 412ms<500ms" */
  function reason(workload, pool, pref, ttftP99, sloTtft) {
    const parts = [];
    if (workload.region) {
      parts.push(`policy=${workload.region} ${pool.region === workload.region ? '✓' : '✗ spill'}`);
    }
    if (workload.compliance) parts.push(`${workload.compliance} ✓ sensitive-capacity`);
    parts.push(pref === 'reserved' ? 'reserved-first'
      : pref === 'lowest_latency' ? 'lowest-latency' : 'cheapest');
    if (ttftP99 != null && sloTtft != null) {
      parts.push(`ttft_p99 ${Math.round(ttftP99)}ms${ttftP99 <= sloTtft ? '<' : '>'}${sloTtft}ms`);
    }
    return `route→${pool.id}: ${parts.join(', ')}`;
  }

  return { ADMIT, PREEMPT, QUEUE, DENY, isSensitive, eligiblePools, planAdmission, reason };
});
