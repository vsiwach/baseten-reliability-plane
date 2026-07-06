# live/ — drive the console against your real clouds

One process, run where your keys live. The console auto-detects it and flips
from the demo workspace to LIVE mode — same panels, same agent code, real
infrastructure.

```bash
export BASETEN_API_KEY=...            # management + inference auth
python3 live/bridge.py                # control plane on 127.0.0.1:8788
python3 -m http.server 8431           # serve the console (separate terminal)
open http://localhost:8431/operate.html   # badge reads LIVE
```

Then drive it from the browser, in order:

1. **▶ Deploy workload (real)** — activates both Baseten deployments over the
   management API (`3ydn1e43/qvm1v4e` T4, `qrj78jv3/wno2dv0` L4:2) and wakes
   the competitor endpoint. Cold starts are measured and shown per pool.
   Traffic starts automatically once everything is ready — the same prompts
   stream to every cloud.
2. **Watch the SLO evidence** — p99s, goodput, and $/Mtok (= instance $/hr ÷
   live measured tok/s) fill from real requests. The win-back card appears
   when the live evidence supports it.
3. **Shadow it now** — real mirrored pairs, the same certify gate, promote on
   PASS. Rollback stays armed; both are real route changes at the bridge.
4. **Inject chaos — degrade cluster-1** — REAL chaos: the bridge deactivates
   the deployment via the management API, then reactivates it. The agent in
   your browser (the same `js/sim/agent.js` the demo runs) quarantines the
   pool, real traffic fails over to the L4 cluster, probes ride the real BDN
   cold start, and reinstatement is verified — real MTTR on the stopwatch.

Costs while everything is warm: T4x8x32 $0.90/hr + L4:2 $2.40/hr + your
competitor A100 (~$3–4/hr) → a 20-minute session ≈ **$2–3 total**. Deactivate
when done:

```bash
python3 ../baseten-mvp/deploy/baseten/manage.py deactivate qvm1v4e --model-id 3ydn1e43 --yes
python3 ../baseten-mvp/deploy/baseten/manage.py deactivate wno2dv0 --model-id qrj78jv3 --yes
```

Config via env: `BT1_MODEL/BT1_DEPLOYMENT`, `BT2_MODEL/BT2_DEPLOYMENT`,
`COMPETITOR_URL`. `?sim=1` on the console URL forces the demo workspace even
while the bridge runs.
