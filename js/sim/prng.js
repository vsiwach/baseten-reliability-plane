/* prng.js — seeded PRNG (mulberry32). Every random draw in the simulator
   comes from one of these streams, so a given ?seed= yields an identical
   event stream (asserted in tests/determinism.test.js).

   Classic-script + CommonJS dual export: the console must open from file://
   (Chrome blocks ES modules there), and node --test must import the same
   code. Each sim module registers on globalThis.RP and exports for node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.RP = root.RP || {}; root.RP.prng = factory(); }
})(globalThis, function () {
  'use strict';

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Skewed positive jitter around 1.0 — sum of uniforms approximates a
     bell, the occasional squared draw fattens the right tail the way real
     TTFT distributions do. */
  function latencyJitter(rand) {
    const bell = (rand() + rand() + rand()) / 3;      // 0..1, centered .5
    const tail = rand() < 0.025 ? 1 + rand() * rand() * 1.5 : 1;
    return (0.75 + bell * 0.5) * tail;                // ~0.75x .. ~2.5x
  }

  function pick(rand, arr) { return arr[Math.floor(rand() * arr.length)]; }

  return { mulberry32, latencyJitter, pick };
});
