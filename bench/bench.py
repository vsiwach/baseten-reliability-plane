#!/usr/bin/env python3
"""bench.py — record real numbers against any OpenAI-compatible endpoint.

Offline evidence tool (the site never calls it): streams N chat completions,
measures per-request TTFT (first content OR reasoning delta — friction #11:
reasoning models stream `delta.reasoning` before any `delta.content`, and a
client watching only content never latches TTFT), tokens/sec, status, and
billed cost when the response reports usage. Writes a CSV in the exact schema
data/recorded/model_api_sweep_*.csv uses, so a fresh recording drops in as
provenance without any conversion.

Works on Baseten dedicated deployments, Baseten Model APIs, Modal, RunPod —
anything speaking /v1/chat/completions. Stdlib only; no pip installs.

Usage:
  python3 bench/bench.py --url https://inference.baseten.co/v1 \
      --model zai-org/GLM-4.7 --key $BASETEN_API_KEY \
      --alias baseten-model-api -n 60
  python3 bench/bench.py --url https://myorg--qwen3-serve.modal.run/v1 \
      --model Qwen/Qwen3-8B-AWQ --key $MODAL_TOKEN --alias modal-dedicated \
      --usd-hr 1.10 -n 60

For dedicated pools pass --usd-hr (the instance's list price); $/Mtok is then
pool $/hr ÷ measured tok/s — the same rule as js/sim/costs.js. Per-token APIs
report billed cost in usage; leave --usd-hr off.
"""
import argparse
import csv
import json
import time
import urllib.request

PROMPTS = [
    "In one sentence, what makes GPU inference latency hard to keep stable?",
    "Summarize the tradeoff between canary and shadow rollouts in two sentences.",
    "Name three causes of cold-start latency for LLM serving and one mitigation each.",
    "Explain right-of-way scheduling for compliance-bound workloads, briefly.",
]


def one_request(url, model, key, prompt, max_tokens):
    body = json.dumps({
        "model": model, "stream": True, "max_tokens": max_tokens,
        "stream_options": {"include_usage": True},
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        f"{url.rstrip('/')}/chat/completions", data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {key}" if key else ""})
    start = time.monotonic()
    ttft_ms = None
    first_token_at = None
    completion_tokens = 0
    cost_usd = None
    reasoning_only = True
    answer = []
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            status = resp.status
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:") or line == "data: [DONE]":
                    continue
                try:
                    chunk = json.loads(line[5:])
                except json.JSONDecodeError:
                    continue
                usage = chunk.get("usage")
                if usage:
                    completion_tokens = usage.get("completion_tokens", completion_tokens)
                    if "cost" in usage:
                        cost_usd = usage["cost"]
                for choice in chunk.get("choices", []):
                    delta = choice.get("delta", {})
                    # friction #11: reasoning deltas count as first token
                    token = (delta.get("content") or delta.get("reasoning")
                             or delta.get("reasoning_content"))
                    if token:
                        now = time.monotonic()
                        if ttft_ms is None:
                            ttft_ms = (now - start) * 1000
                        first_token_at = first_token_at or now
                        if delta.get("content"):
                            reasoning_only = False
                            answer.append(delta["content"])
                        completion_tokens += 0  # counted via usage when present
    except Exception as exc:  # noqa: BLE001 — a failed request is a data point
        return {"status": getattr(exc, "code", 0), "ttft_ms": None,
                "tok_per_sec": None, "cost_usd": None, "completion_tokens": 0,
                "reasoning_only": True, "answer": str(exc)[:100]}
    elapsed = time.monotonic() - start
    decode_s = elapsed - (0 if ttft_ms is None else ttft_ms / 1000)
    tps = (completion_tokens / decode_s) if completion_tokens and decode_s > 0 else None
    return {"status": status, "ttft_ms": ttft_ms, "tok_per_sec": tps,
            "cost_usd": cost_usd, "completion_tokens": completion_tokens,
            "reasoning_only": reasoning_only,
            "answer": "".join(answer)[:100].replace("\n", " ")}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--url", required=True, help="base URL ending in /v1")
    ap.add_argument("--model", required=True)
    ap.add_argument("--key", default="")
    ap.add_argument("--alias", required=True, help="pool id for the CSV rows")
    ap.add_argument("-n", type=int, default=60)
    ap.add_argument("--max-tokens", type=int, default=120)
    ap.add_argument("--usd-hr", type=float, default=None,
                    help="instance list price for dedicated pools")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = args.out or f"data/recorded/model_api_sweep_{stamp}.csv"
    fields = ["alias", "status", "ttft_ms", "tok_per_sec", "cost_usd",
              "completion_tokens", "replica", "reasoning_only", "answer"]
    rows = []
    for i in range(args.n):
        r = one_request(args.url, args.model, args.key,
                        PROMPTS[i % len(PROMPTS)], args.max_tokens)
        r["alias"] = args.alias
        r["replica"] = args.alias
        rows.append(r)
        print(f"{i + 1}/{args.n} status={r['status']} "
              f"ttft={r['ttft_ms'] and round(r['ttft_ms']) }ms "
              f"tps={r['tok_per_sec'] and round(r['tok_per_sec'], 1)}")
        time.sleep(0.5)  # friction #10: stay far under hosted rate limits

    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in fields})

    ok = [r for r in rows if r["status"] == 200 and r["ttft_ms"]]
    if ok:
        ttfts = sorted(r["ttft_ms"] for r in ok)
        p50 = ttfts[len(ttfts) // 2]
        p99 = ttfts[min(len(ttfts) - 1, int(len(ttfts) * 0.99))]
        tps = sorted(r["tok_per_sec"] for r in ok if r["tok_per_sec"])
        line = f"{args.alias}: n={len(ok)} ttft p50={p50:.0f}ms p99={p99:.0f}ms"
        if tps:
            mtps = tps[len(tps) // 2]
            line += f" tok/s p50={mtps:.1f}"
            if args.usd_hr:
                line += (f" → $/Mtok = {args.usd_hr}/hr ÷ {mtps:.1f} tok/s = "
                         f"${args.usd_hr / (mtps * 3600) * 1e6:.2f}")
        costs = [r["cost_usd"] for r in ok if r["cost_usd"]]
        toks = sum(r["completion_tokens"] for r in ok if r["cost_usd"])
        if costs and toks:
            line += f" · billed ${sum(costs) / toks * 1e6:.2f}/Mtok"
        print(line)
    print("wrote", out)


if __name__ == "__main__":
    main()
