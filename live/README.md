# live/ — drive the console against your real clouds

One process, run where your keys live. The console auto-detects it and flips
from the demo workspace to LIVE mode — same panels, same agent code, real
infrastructure.

```bash
export BASETEN_API_KEY=...            # management + inference auth
export COMPETITOR_URL=...             # your OpenAI-compatible external endpoint /v1
                                      # (the default is a personal Modal URL — set your own)
python3 live/bridge.py                # control plane on 127.0.0.1:8788
python3 -m http.server 8431           # serve the console (separate terminal)
open http://localhost:8431/operate.html   # badge reads LIVE
```

Then drive it from the browser, in order:

1. **▶ Deploy workload (real)** — activates the dedicated Baseten deployment
   over the management API (`BT1_MODEL/BT1_DEPLOYMENT`, defaults
   `3ydn1e43/qrpv7y0` — a T4x8x32) and wakes the competitor endpoint. The
   failover target is Baseten's serverless Model APIs
   (`inference.baseten.co/v1`) — always-on, so it needs no activation. Cold
   starts are measured and shown per pool. Traffic starts automatically once
   everything is ready — the same prompts stream to every cloud.
2. **Watch the SLO evidence** — p99s, goodput, and $/Mtok (= instance $/hr ÷
   live measured tok/s) fill from real requests. The win-back card appears
   when the live evidence supports it.
3. **Shadow it now** — real mirrored pairs, the same certify gate, promote on
   PASS. Rollback stays armed; both are real route changes at the bridge.
4. **Inject chaos — degrade cluster-1** — REAL chaos: the bridge deactivates
   the dedicated deployment via the management API, then reactivates it. The
   agent in your browser (the same `js/sim/agent.js` the demo runs) quarantines
   the pool, real traffic fails over per `spill_order` to the serverless Model
   APIs, probes ride the real BDN cold start, and reinstatement is verified —
   real MTTR on the stopwatch. This is a genuine `deactivate` against a real
   deployment: only the pool set here is touched, but treat the chaos button as
   live.

Costs while everything is warm: T4x8x32 $0.90/hr + serverless Model APIs
(per-token, no idle) + your competitor endpoint (~$3–4/hr) → a 20-minute
session ≈ **$2–3 total**. The serverless failover pool bills only on the
traffic a chaos drill spills to it. Deactivate the dedicated deployment when
done:

```bash
python3 ../baseten-mvp/deploy/baseten/manage.py deactivate qrpv7y0 --model-id 3ydn1e43 --yes
# (or your own BT1_DEPLOYMENT / BT1_MODEL if you overrode the defaults)
```

Config via env: `BT1_MODEL/BT1_DEPLOYMENT` (dedicated pool) and
`COMPETITOR_URL` (your external OpenAI-compatible endpoint; required — the
built-in default is a personal URL). `?sim=1` on the console URL forces the
demo workspace even while the bridge runs.
