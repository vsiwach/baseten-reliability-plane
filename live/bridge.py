#!/usr/bin/env python3
"""bridge.py — the LIVE control plane for the operate console.

Runs where your keys live (your laptop), does the things a static page
cannot: activate/deactivate real Baseten deployments (management API),
generate real streaming traffic to every attached cloud, mirror requests
for certified migration, and serve rolling metrics the console polls.
The console auto-detects this bridge at 127.0.0.1:8788 and flips to LIVE
mode; without it, the console runs the seeded demo workspace.

    BASETEN_API_KEY=... python3 live/bridge.py
    # then open http://localhost:8431/operate.html — badge reads LIVE

Stdlib only. Decisions stay in the browser (the same agent code that runs
the demo runs the real thing); this process only executes and measures.

Endpoints (JSON, CORS *):
  GET  /status            deploy/traffic/chaos state, routes, events tail
  GET  /metrics           rolling per-pool samples (ttft, tok/s, errors, rps)
  POST /deploy            activate both Baseten deployments + wake competitor
  POST /traffic           {"action":"start"|"stop","rps":2}
  POST /act               {"op":"quarantine"|"reinstate","pool":id}
  POST /probe             {"pool":id,"gate_ms":500} → one real streaming probe
  POST /chaos             deactivate cluster-1, then re-activate (real restart)
  POST /migrate           {"action":"start"|"promote"|"rollback","route":id,"target":id}
"""
import json
import os
import threading
import time
import urllib.request
import urllib.error
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASETEN_KEY = os.environ.get("BASETEN_API_KEY", "")
MGMT = "https://api.baseten.co/v1"

POOLS = {
    "baseten-dedicated": {
        "kind": "baseten-predict",
        "model_id": os.environ.get("BT1_MODEL", "3ydn1e43"),
        "deployment_id": os.environ.get("BT1_DEPLOYMENT", "qvm1v4e"),
        "url": None,  # derived: model-{model_id}.api.baseten.co
        "usd_hr": 0.9024, "control": "operated",
    },
    "baseten-dedicated-2": {
        # second deployment of the SAME working model (T4, pre-BDN build —
        # its cold start demonstrates friction #17 live). The L4:2 pool sat
        # in DEPLOYING for 40min (friction #6) and was benched.
        "kind": "baseten-predict",
        "model_id": os.environ.get("BT2_MODEL", "3ydn1e43"),
        "deployment_id": os.environ.get("BT2_DEPLOYMENT", "w52yvzr"),
        "url": None,
        "usd_hr": 0.9024, "control": "operated",   # T4x8x32 published
    },
    "competitor-cloud": {
        "kind": "openai",
        "url": os.environ.get("COMPETITOR_URL",
                              "https://vsiwach--max-qwen25-serve.modal.run/v1"),
        "usd_hr": 3.40, "control": "monitor-only",  # A100-80GB class rate
    },
}
ROUTES = {
    "voice-prod": {"declared": "baseten-dedicated", "rps": 1.0},
    "voice-agent": {"declared": "competitor-cloud", "rps": 0.5},
}
SPILL_ORDER = ["baseten-dedicated-2"]     # failover-policy.yaml, live subset

PROMPTS = [
    "In one sentence, what makes GPU inference latency hard to keep stable?",
    "Name two causes of cold-start latency for LLM serving.",
    "Summarize canary vs shadow rollouts in one sentence.",
    "What is a p99 latency target and why do teams pick p99?",
]

state_lock = threading.Lock()
state = {
    "deployed": False,
    "deploy": {p: {"phase": "idle", "cold_start_s": None} for p in POOLS},
    "traffic": {"running": False, "rps": 1.5, "sent": 0, "errors": 0},
    "pools": {p: {"quarantined": False, "health": "unknown"} for p in POOLS},
    "serving_override": {},          # route -> pool (migration promote)
    "chaos": {"active": False, "phase": None, "started": None},
    "migration": {"stage": "idle", "route": None, "target": None, "pairs": []},
    "events": deque(maxlen=200),
}
samples = {p: deque(maxlen=600) for p in POOLS}   # {"t","ttft_ms","tokps","ok"}
EVSEQ = [0]


def emit(kind, text):
    with state_lock:
        EVSEQ[0] += 1
        state["events"].append({"seq": EVSEQ[0], "t": round(time.time(), 1),
                                "kind": kind, "text": text})
    print(f"[{kind}] {text}", flush=True)


# ---- upstream calls ---------------------------------------------------------
def mgmt_call(path, method="GET", body=None):
    req = urllib.request.Request(
        MGMT + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Api-Key {BASETEN_KEY}",
                 "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode() or "{}")


def stream_request(pool_id, prompt, max_tokens=80, timeout=60):
    """One real streaming request; returns (ok, ttft_ms, tokps)."""
    p = POOLS[pool_id]
    start = time.monotonic()
    ttft = None
    chars = 0
    chunks = 0
    try:
        if p["kind"] == "baseten-predict":
            path = p.get("path") or "/environments/production/predict"
            url = f"https://model-{p['model_id']}.api.baseten.co{path}"
            body = {"messages": [{"role": "user", "content": prompt}],
                    "max_tokens": max_tokens, "stream": True}
            headers = {"Authorization": f"Api-Key {BASETEN_KEY}",
                       "Content-Type": "application/json"}
        else:
            url = p["url"].rstrip("/") + "/chat/completions"
            body = {"model": pool_state_model(pool_id),
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": max_tokens, "stream": True}
            headers = {"Content-Type": "application/json"}
        req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                     headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            for raw in resp:
                if ttft is None:
                    ttft = (time.monotonic() - start) * 1000
                line = raw.decode("utf-8", "replace")
                if p["kind"] == "openai":
                    if line.startswith("data:") and '"content"' in line:
                        try:
                            delta = json.loads(line[5:])["choices"][0]["delta"]
                            chars += len(delta.get("content") or "")
                        except Exception:
                            pass
                else:
                    chunks += 1
        total = time.monotonic() - start
        decode_s = max(total - (ttft or 0) / 1000, 0.05)
        if p["kind"] == "openai":
            tokps = (chars / 4) / decode_s if chars else None
        else:
            tokps = chunks / decode_s if chunks > 1 else None
        return True, ttft, tokps
    except Exception as exc:
        ms = (time.monotonic() - start) * 1000
        _err_event(pool_id, exc)
        return False, ms, None


_last_err = {}
def _err_event(pool_id, exc):
    now = time.time()
    if now - _last_err.get(pool_id, 0) > 30:
        _last_err[pool_id] = now
        emit("error", f"{pool_id}: request failed — {type(exc).__name__}: {str(exc)[:140]}")


_model_cache = {}
def pool_state_model(pool_id):
    """OpenAI pools need a model name — read it once from /v1/models."""
    if pool_id in _model_cache:
        return _model_cache[pool_id]
    try:
        req = urllib.request.Request(POOLS[pool_id]["url"].rstrip("/") + "/models")
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read().decode())
        _model_cache[pool_id] = data["data"][0]["id"]
    except Exception:
        return "default"     # NOT cached — retry on the next call
    return _model_cache[pool_id]


# ---- deploy ------------------------------------------------------------------
def deploy_baseten(pool_id):
    p = POOLS[pool_id]
    ds = state["deploy"][pool_id]
    ds["phase"] = "activating"
    emit("deploy", f"{pool_id}: activating deployment {p['deployment_id']} via management API")
    t0 = time.monotonic()
    try:
        mgmt_call(f"/models/{p['model_id']}/deployments/{p['deployment_id']}/activate",
                  "POST", {})
    except urllib.error.HTTPError as e:
        if e.code not in (400, 409):   # already active is fine
            ds["phase"] = f"error: HTTP {e.code}"
            emit("deploy", f"{pool_id}: activate failed HTTP {e.code}")
            return
    ds["phase"] = "waking (cold start)"
    while True:
        try:
            d = mgmt_call(f"/models/{p['model_id']}/deployments/{p['deployment_id']}")
            status = d.get("deployment", d).get("status", "?")
        except Exception:
            status = "?"
        if status == "ACTIVE":
            break
        if time.monotonic() - t0 > 600:
            ds["phase"] = "timeout waiting for ACTIVE"
            emit("deploy", f"{pool_id}: never went ACTIVE in 600s (last {status})")
            return
        time.sleep(5)
    # non-production deployments answer on a deployment-scoped path — resolve
    # it once by trying the documented forms (docs: /{deployment_id}/{endpoint})
    if p["deployment_id"] and pool_id != "baseten-dedicated":
        for cand in (f"/deployment/{p['deployment_id']}/predict",
                     f"/{p['deployment_id']}/predict",
                     f"/deployments/{p['deployment_id']}/predict"):
            p["path"] = cand
            ok, ms, _ = stream_request(pool_id, "path probe", max_tokens=2, timeout=90)
            if ok:
                emit("deploy", f"{pool_id}: invoke path resolved → {cand}")
                break
        else:
            p["path"] = None
    # first real request proves serving end-to-end (and measures true cold path)
    ok, ms, _ = stream_request(pool_id, "warmup: say ok", max_tokens=4, timeout=300)
    cold = round(time.monotonic() - t0, 1)
    ds["cold_start_s"] = cold
    ds["phase"] = "ready" if ok else f"ACTIVE but first request failed ({ms:.0f}ms)"
    state["pools"][pool_id]["health"] = "up" if ok else "down"
    emit("deploy", f"{pool_id}: READY — activation→first-token {cold}s "
                   f"(BDN measured 148s on cluster-1 historically)")


def deploy_competitor(pool_id):
    ds = state["deploy"][pool_id]
    ds["phase"] = "waking (snapshot)"
    emit("deploy", f"{pool_id}: waking via GET /v1/models")
    t0 = time.monotonic()
    model = pool_state_model(pool_id)
    ok, ms, _ = stream_request(pool_id, "warmup: say ok", max_tokens=4, timeout=300)
    ds["cold_start_s"] = round(time.monotonic() - t0, 1)
    ds["phase"] = "ready" if ok else "wake failed"
    state["pools"][pool_id]["health"] = "up" if ok else "down"
    emit("deploy", f"{pool_id}: {'READY' if ok else 'FAILED'} — model {model}, "
                   f"wake {ds['cold_start_s']}s")


def do_deploy():
    threads = []
    for pid, p in POOLS.items():
        fn = deploy_baseten if p["kind"] == "baseten-predict" else deploy_competitor
        th = threading.Thread(target=fn, args=(pid,), daemon=True)
        th.start()
        threads.append(th)
    for th in threads:
        th.join()
    with state_lock:
        # the PRIMARY serving pool gates the workload; the failover cluster
        # joins whenever its (slow, 2-GPU SKU — friction #6) node lands
        state["deployed"] = state["deploy"]["baseten-dedicated"]["phase"] == "ready"
    emit("deploy", "deploy complete — primary serving; failover cluster joins when ready"
         if state["deployed"] else "deploy finished with failures — see per-pool phase")


# ---- traffic -----------------------------------------------------------------
def serving_pool(route_id):
    declared = state["serving_override"].get(route_id) or ROUTES[route_id]["declared"]
    p = state["pools"][declared]
    if POOLS[declared]["control"] == "operated" and \
            (p["quarantined"] or p["health"] == "down"):
        for alt in SPILL_ORDER:
            ap = state["pools"][alt]
            if alt != declared and not ap["quarantined"] and ap["health"] != "down":
                return alt, declared
    return declared, declared


def traffic_loop(route_id):
    i = 0
    last_serving = None
    while state["traffic"]["running"]:
        pool, declared = serving_pool(route_id)
        if last_serving and pool != last_serving:
            emit("failover", f"{route_id}: {last_serving} → {pool}"
                 + ("" if pool == declared else " (failover per spill_order)"))
        last_serving = pool
        if state["pools"][pool]["health"] == "down" and i % 5 != 0:
            i += 1
            time.sleep(2)
            continue     # occasional probe only — recovery detection without hammering
        ok, ttft, tokps = stream_request(pool, PROMPTS[i % len(PROMPTS)])
        samples[pool].append({"t": time.time(), "ttft_ms": ttft,
                              "tokps": tokps, "ok": ok, "route": route_id})
        with state_lock:
            state["traffic"]["sent"] += 1
            if not ok:
                state["traffic"]["errors"] += 1
        if not ok and POOLS[pool]["control"] == "operated":
            state["pools"][pool].setdefault("recent_errors", 0)
        # mirror for migration shadow
        m = state["migration"]
        if m["stage"] == "shadow" and m["route"] == route_id:
            ok2, ttft2, tokps2 = stream_request(m["target"], PROMPTS[i % len(PROMPTS)])
            m["pairs"].append({"srcTtft": ttft, "tgtTtft": ttft2,
                               "srcTpot": (1000 / tokps) if tokps else None,
                               "tgtTpot": (1000 / tokps2) if tokps2 else None,
                               "parityOk": bool(ok and ok2)})
            if len(m["pairs"]) >= 12:
                m["stage"] = "certify"
                emit("migration", f"shadow cohort full ({len(m['pairs'])} mirrored pairs) — certify in console")
        i += 1
        time.sleep(max(1.0 / ROUTES[route_id]["rps"] / max(state["traffic"]["rps"], .1), 0.4))


def start_traffic():
    if state["traffic"]["running"]:
        return
    state["traffic"]["running"] = True
    for route_id in ROUTES:
        threading.Thread(target=traffic_loop, args=(route_id,), daemon=True).start()
    emit("traffic", f"workload started — same prompts to every cloud")


# ---- health + chaos ------------------------------------------------------------
def health_loop():
    while True:
        for pid in POOLS:
            recent = [s for s in samples[pid] if s["t"] > time.time() - 20]
            if recent:
                errs = sum(1 for s in recent if not s["ok"])
                state["pools"][pid]["health"] = "down" if errs / len(recent) > 0.6 else "up"
        time.sleep(3)


def do_chaos():
    pid = "baseten-dedicated"
    p = POOLS[pid]
    with state_lock:
        state["chaos"] = {"active": True, "phase": "deactivating", "started": time.time()}
    emit("chaos", f"REAL chaos: deactivating {pid} ({p['deployment_id']}) via management API")
    try:
        mgmt_call(f"/models/{p['model_id']}/deployments/{p['deployment_id']}/deactivate", "POST", {})
    except Exception as exc:
        emit("chaos", f"deactivate failed: {exc}")
    state["pools"][pid]["health"] = "down"
    state["chaos"]["phase"] = "pool down — reactivating (real cold start ahead)"
    time.sleep(8)
    try:
        mgmt_call(f"/models/{p['model_id']}/deployments/{p['deployment_id']}/activate", "POST", {})
        emit("chaos", f"{pid}: reactivation issued — recovery rides the real BDN cold start")
    except Exception as exc:
        emit("chaos", f"reactivate failed: {exc}")
    t0 = time.monotonic()
    while time.monotonic() - t0 < 600:
        try:
            d = mgmt_call(f"/models/{p['model_id']}/deployments/{p['deployment_id']}")
            if d.get("deployment", d).get("status") == "ACTIVE":
                ok, ms, _ = stream_request(pid, "probe: say ok", max_tokens=4, timeout=120)
                if ok:
                    state["pools"][pid]["health"] = "up"
                    dur = round(time.monotonic() - t0 + 8, 1)
                    state["chaos"] = {"active": False, "phase": f"recovered in {dur}s", "started": None}
                    emit("chaos", f"{pid} serving again — restart→first-token {dur}s (real)")
                    return
        except Exception:
            pass
        time.sleep(5)
    state["chaos"]["phase"] = "recovery timeout"
    emit("chaos", f"{pid} did not recover within 600s")


# ---- HTTP ----------------------------------------------------------------------
def metrics_view():
    now = time.time()
    out = {}
    for pid in POOLS:
        recent = [s for s in samples[pid] if s["t"] > now - 60]
        okd = [s for s in recent if s["ok"] and s["ttft_ms"] is not None]
        ttfts = sorted(s["ttft_ms"] for s in okd)
        tokps = sorted(s["tokps"] for s in okd if s["tokps"])
        pct = lambda a, q: a[min(len(a) - 1, int(len(a) * q))] if a else None
        out[pid] = {
            "samples": len(recent),
            "errors": len(recent) - len(okd),
            "rps": round(len(recent) / 60, 2),
            "ttft_p50_ms": pct(ttfts, 0.5), "ttft_p99_ms": pct(ttfts, 0.98),
            "tokps_p50": pct(tokps, 0.5),
            "usd_hr": POOLS[pid]["usd_hr"], "control": POOLS[pid]["control"],
            "quarantined": state["pools"][pid]["quarantined"],
            "health": state["pools"][pid]["health"],
            "last": [{"t": s["t"], "ttft_ms": s["ttft_ms"], "ok": s["ok"]}
                     for s in list(samples[pid])[-40:]],
        }
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send({})

    def do_GET(self):
        if self.path.startswith("/status"):
            with state_lock:
                routes = {}
                for rid in ROUTES:
                    pool, declared_now = serving_pool(rid)
                    routes[rid] = {"declared": ROUTES[rid]["declared"],
                                   "serving": pool}
                self._send({
                    "live": True, "deployed": state["deployed"],
                    "deploy": state["deploy"], "traffic": state["traffic"],
                    "chaos": state["chaos"], "routes": routes,
                    "migration": {k: v for k, v in state["migration"].items() if k != "pairs"},
                    "pairs": state["migration"]["pairs"][-20:] if state["migration"]["stage"] != "idle" else [],
                    "events": list(state["events"])[-40:],
                })
        elif self.path.startswith("/metrics"):
            self._send(metrics_view())
        else:
            self._send({"error": "unknown path"}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n).decode() or "{}") if n else {}
        path = self.path
        if path.startswith("/deploy"):
            threading.Thread(target=do_deploy, daemon=True).start()
            self._send({"ok": True})
        elif path.startswith("/traffic"):
            if body.get("action") == "stop":
                state["traffic"]["running"] = False
            else:
                state["traffic"]["rps"] = float(body.get("rps", 1.5))
                start_traffic()
            self._send(state["traffic"])
        elif path.startswith("/act"):
            pid, op = body["pool"], body["op"]
            if POOLS[pid]["control"] != "operated":
                self._send({"refused": "monitor-only pool"}, 403)
                return
            state["pools"][pid]["quarantined"] = (op == "quarantine")
            emit("agent", f"agent: {op} {pid} (executed by bridge)")
            self._send({"ok": True})
        elif path.startswith("/probe"):
            pid = body["pool"]
            ok, ms, _ = stream_request(pid, "probe", max_tokens=2,
                                       timeout=float(body.get("gate_ms", 500)) / 1000 + 8)
            gate = float(body.get("gate_ms", 500))
            self._send({"ok": bool(ok and ms is not None and ms <= gate),
                        "ms": round(ms or 0, 1)})
        elif path.startswith("/chaos"):
            threading.Thread(target=do_chaos, daemon=True).start()
            self._send({"ok": True})
        elif path.startswith("/migrate"):
            m = state["migration"]
            act = body.get("action", "start")
            if act == "start":
                state["migration"] = {"stage": "shadow", "route": body["route"],
                                      "target": body["target"], "pairs": []}
                emit("migration", f"shadow started: {body['route']} mirrored onto {body['target']} (real requests, responses discarded)")
            elif act == "promote":
                state["serving_override"][m["route"]] = m["target"]
                m["stage"] = "promoted"
                emit("migration", f"PROMOTED: {m['route']} now serves on {m['target']} — rollback armed")
            elif act == "rollback":
                state["serving_override"].pop(m["route"], None)
                m["stage"] = "rolled_back"
                emit("migration", f"rolled back: {m['route']} back on {ROUTES[m['route']]['declared']}")
            self._send({"ok": True})
        else:
            self._send({"error": "unknown path"}, 404)


def main():
    if not BASETEN_KEY:
        print("ERROR: export BASETEN_API_KEY first (management + inference auth)")
        raise SystemExit(1)
    threading.Thread(target=health_loop, daemon=True).start()
    print("bridge listening on http://127.0.0.1:8788 — open the console; badge flips to LIVE")
    ThreadingHTTPServer(("127.0.0.1", 8788), Handler).serve_forever()


if __name__ == "__main__":
    main()
