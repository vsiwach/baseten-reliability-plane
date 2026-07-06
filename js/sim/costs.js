/* costs.js — measured-only economics, ported from ai-native-pipeline
   router_app/costs.py. One rule, no estimates:

       usd_per_mtok = pool_$/hr ÷ measured tokens/sec

   and goodput = fraction of requests meeting the SLO. Anything this module
   cannot compute from real inputs returns null — the UI renders null as
   "no data yet", never as zero. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.RP = root.RP || {}; root.RP.costs = factory(); }
})(globalThis, function () {
  'use strict';

  function usdPerMtok(usdHr, tokPerSec) {
    if (usdHr == null || !tokPerSec || tokPerSec <= 0) return null;
    return usdHr / (tokPerSec * 3600) * 1e6;
  }

  function goodput(sloMet, requests) {
    if (!requests) return null;
    return sloMet / requests;
  }

  function percentile(values, p) {
    if (!values || !values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
    return s[Math.max(0, idx)];
  }

  /* Blended $/Mtok across pools, weighted by tokens each pool served.
     Per-pool prices must be measured; the traffic mix is whatever the
     window saw. Pools with no measured price make the blend null rather
     than silently wrong. */
  function blendedUsdPerMtok(perPool) {
    let usd = 0, tokens = 0;
    for (const { usd_per_mtok, tokens: t } of perPool) {
      if (!t) continue;
      if (usd_per_mtok == null) return null;
      usd += usd_per_mtok * t; tokens += t;
    }
    return tokens ? usd / tokens : null;
  }

  function median(values) {
    if (!values || !values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  return { usdPerMtok, goodput, percentile, blendedUsdPerMtok, median };
});
