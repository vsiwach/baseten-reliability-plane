# bench/ — refresh the evidence

Stdlib-only recording harness. The site never calls it; you run it offline
against your own endpoints and commit the CSVs into `data/recorded/` (add a
line to `PROVENANCE.md`). One command per provider:

```bash
# Baseten Model APIs (per-token billed — cost comes from the response usage)
python3 bench/bench.py --url https://inference.baseten.co/v1 \
  --model zai-org/GLM-4.7 --key "$BASETEN_API_KEY" --alias baseten-model-api -n 60

# Baseten dedicated (metered — pass the instance list price)
python3 bench/bench.py --url https://model-XXXXX.api.baseten.co/environments/production/sync/v1 \
  --model qwen3-8b-awq --key "$BASETEN_API_KEY" --alias baseten-dedicated --usd-hr 0.9024 -n 60

# Your competitor cloud (upgrades competitor-cloud from SIMULATED to MEASURED)
python3 bench/bench.py --url https://qwen3.your-competitor-cloud.example/v1 \
  --model Qwen/Qwen3-8B-AWQ --key "$COMPETITOR_TOKEN" --alias competitor-cloud --usd-hr 1.10 -n 60
```

Measured lessons already encoded in the harness, from the friction log:
- **#11** — reasoning models stream `delta.reasoning` before any `delta.content`;
  the first reasoning delta latches TTFT, or you never measure it.
- **#10** — hosted Model APIs rate-limit per model per workspace with no
  `Retry-After`; the harness paces at ≤2 rps.
- Cost rule (same as `js/sim/costs.js`): dedicated pools are
  `list $/hr ÷ measured tok/s`; per-token APIs use the billed cost the API reports.
