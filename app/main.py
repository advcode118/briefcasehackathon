"""FastAPI app: webhook -> agent -> gate -> Stripe, plus the dashboard API (IMPLEMENTATION §3)."""
import collections
import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from fastapi import Body, FastAPI, HTTPException, Query  # noqa: E402
from fastapi.responses import FileResponse, HTMLResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from . import agent, seed, stripe_client  # noqa: E402
from .store import now_iso, store  # noqa: E402

stripe_client.check_safety()  # refuse to start with a live key

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
VERSIONS = ["v1", "v2", "v3", "v4"]
EXECUTED = {"paid", "escrow_authorised", "escrow_captured"}
PROVER_N = 60

FALLBACK_THEOREMS = {
    "T1": "Unapproved spend can never exceed £500,000 in 30 days",
    "T2": "No vendor can receive over £10,000 in a day without approval",
    "T3": "No invoice is ever paid twice",
    "T5": "Total paid against any PO ≤ received × contract price",
    "T6": "Escrow conserves money",
    "T7": "A valid invoice is always paid automatically (no over-blocking)",
    "T8": "A sub-agent's policy allows nothing the parent policy blocks",
}


# ---------------------------------------------------------------- policy helpers

def _policy_mod():
    from . import policy
    return policy


def active_policy():
    return _policy_mod().get_policy(store.policy_version)


def policy_view() -> dict:
    from . import rules
    pm = _policy_mod()
    pol = pm.get_policy(store.policy_version)
    return {
        "version": pol.version,
        "hash": pol.hash,
        "note": pol.note,
        "versions": [{"id": v, "note": pm.POLICIES[v].note} for v in pm.POLICIES],
        "rules": [
            {"id": r.id, "text": r.text, "decision": r.decision, "condition": r.condition,
             "active": r.id in pol.rule_ids}
            for r in rules.RULES.values()
        ],
    }


# ---------------------------------------------------------------- prover (background)

class ProverRunner:
    """One worker thread; versions queue up so Z3 runs never overlap."""

    def __init__(self):
        self.cv = threading.Condition()
        self.queue: collections.deque[str] = collections.deque()
        self.running: set[str] = set()
        self.thread: threading.Thread | None = None

    def enqueue(self, version: str, front: bool = False) -> None:
        with self.cv:
            if version in self.running or version in self.queue:
                if front and version in self.queue:
                    self.queue.remove(version)
                    self.queue.appendleft(version)
                return
            (self.queue.appendleft if front else self.queue.append)(version)
            if self.thread is None or not self.thread.is_alive():
                self.thread = threading.Thread(target=self._loop, daemon=True, name="prover")
                self.thread.start()
            self.cv.notify()

    def is_busy(self, version: str) -> bool:
        with self.cv:
            return version in self.running or version in self.queue

    def _loop(self) -> None:
        while True:
            with self.cv:
                while not self.queue:
                    self.cv.wait()
                version = self.queue.popleft()
                self.running.add(version)
            try:
                result = run_prover(version)
                store.set_prove(version, result)
            finally:
                with self.cv:
                    self.running.discard(version)


runner = ProverRunner()


# T8 compares the active policy with v4, so under v4 it is true by construction; leave it out.
SHOWN_THEOREMS = ("T1", "T2", "T3", "T5", "T6", "T7")


def _theorem_statements() -> dict:
    try:
        from . import prover
        stmts = dict(prover.THEOREMS)
    except Exception:  # noqa: BLE001
        stmts = FALLBACK_THEOREMS
    return {k: v for k, v in stmts.items() if k in SHOWN_THEOREMS}


def _policy_hash(version: str) -> str | None:
    try:
        return _policy_mod().get_policy(version).hash
    except Exception:  # noqa: BLE001
        return None


def empty_prove(version: str, status: str = "pending", error: str | None = None) -> dict:
    out = {
        "version": version, "hash": _policy_hash(version), "n": PROVER_N, "running": False,
        "theorems": [{"id": tid, "statement": st, "status": status, "seconds": None, "counterexample": None}
                     for tid, st in _theorem_statements().items()],
        "worst_case": {"status": "pending", "value": None, "seconds": None},
    }
    if error:
        out["error"] = error
        for t in out["theorems"]:
            t["error"] = error
    return out


def run_prover(version: str) -> dict:
    """Run the theorems one at a time, publishing partial results to the cache as they land."""
    t0 = time.time()
    try:
        from . import prover
        result = empty_prove(version)
        result["running"] = True
        prev = store.get_prove(version)
        if prev and prev.get("hash") == result["hash"]:
            # keep showing the previous run's statuses until each theorem is re-proved
            result["theorems"] = [dict(t) for t in prev.get("theorems", result["theorems"])]
            result["worst_case"] = dict(prev.get("worst_case") or result["worst_case"])
        ids = [t["id"] for t in empty_prove(version)["theorems"]]
        for i, tid in enumerate(ids):
            part = prover.prove_all(version, n=PROVER_N, include=[tid], worst=False)
            for k in ("hash", "n", "bound"):
                if k in part:
                    result[k] = part[k]
            th = (part.get("theorems") or [None])[0] or {"id": tid, "status": "error", "error": "no result"}
            result["theorems"][i] = th
            store.set_prove(version, dict(result))
        try:
            result["worst_case"] = prover.worst_case(prover.build_slots(version, PROVER_N))
        except Exception as e:  # noqa: BLE001
            result["worst_case"] = {"status": "error", "value": None, "seconds": None,
                                    "error": f"{type(e).__name__}: {e}"[:300]}
    except Exception as e:  # noqa: BLE001 - the prover must never take the app down
        result = empty_prove(version, status="error", error=f"{type(e).__name__}: {e}"[:500])
    result["running"] = False
    result.setdefault("version", version)
    result["seconds_total"] = round(time.time() - t0, 2)
    return result


def prove_view(version: str) -> dict:
    cached = store.get_prove(version)
    out = dict(cached) if cached else empty_prove(version)
    out["running"] = runner.is_busy(version)
    return out


def start_prover_all() -> None:
    runner.enqueue(store.policy_version)
    for v in VERSIONS:
        runner.enqueue(v)


# ---------------------------------------------------------------- app

@asynccontextmanager
async def lifespan(app):
    if not os.environ.get("PROVEN_NO_PROVER"):
        start_prover_all()
    yield


app = FastAPI(title="Proven", lifespan=lifespan)

if STATIC.is_dir():
    app.mount("/static", StaticFiles(directory=STATIC), name="static")


def _page(name: str, title: str):
    path = STATIC / name
    if path.exists():
        return FileResponse(path)
    return HTMLResponse(f"<!doctype html><title>Proven</title><h1>Proven: {title}</h1>"
                        f"<p>{name} is not built yet. API: <a href='/api/payments'>/api/payments</a>, "
                        f"<a href='/api/policy'>/api/policy</a>, <a href='/api/prove'>/api/prove</a>.</p>")


@app.get("/", include_in_schema=False)
def index():
    return _page("index.html", "payments")


@app.get("/settings", include_in_schema=False)
def settings():
    return _page("settings.html", "settings")


# ---------------------------------------------------------------- payment helpers

def effective_amount(p: dict) -> int:
    if p["status"] == "escrow_captured":
        return p.get("captured_amount") or 0
    return p["amount"]


def summary() -> dict:
    pays = store.snapshot_payments()
    day = store.day
    executed = [p for p in pays if p["status"] in EXECUTED]
    return {
        "day": day,
        "total_paid": sum(effective_amount(p) for p in executed),
        "held": sum(p["status"] == "held" for p in pays),
        "blocked": sum(p["status"] == "blocked" for p in pays),
        "escrow": sum(p["status"] == "escrow_authorised" for p in pays),
        "auto_spend_window": sum(effective_amount(p) for p in executed
                                 if p.get("auto") and p["day"] > day - seed.WINDOW_DAYS),
        "auto_cap": seed.AUTO_CAP,
        "stripe_mode": stripe_client.mode(),
        "agent_mode": agent.mode(),
        "policy_version": store.policy_version,
    }


def _get(payment_id: str) -> dict:
    p = store.get_payment(payment_id)
    if p is None:
        raise HTTPException(404, f"no payment {payment_id}")
    return p


def note(p: dict, text: str) -> None:
    """Extend the verdict after a human action: "Held by P7: ... — approved by alice, paid." """
    base = p["verdict"].rstrip(".")
    p["verdict"] = f"{base} — {text}."


def gbp(pence: int) -> str:
    from .rules import fmt_gbp
    return fmt_gbp(pence)


def execute(p: dict, as_: str, auto: bool) -> None:
    """Run the Stripe side of an allow/escrow decision and set status. Mutates p."""
    try:
        pi = stripe_client.create(p, p["vendor_name"], as_, active_policy())
    except Exception as e:  # noqa: BLE001 - keep the payment, mark it held for retry
        p["status"] = "held"
        p["stripe_error"] = f"{type(e).__name__}: {e}"[:300]
        note(p, "Stripe call failed, so it stays held (approve to retry)")
        return
    p.pop("stripe_error", None)
    p["auto"] = auto
    p["stripe_pi_id"] = pi["id"]
    p["stripe_status"] = pi["status"]
    p["stripe_url"] = stripe_client.dashboard_url(pi["id"])
    if as_ == "escrow":
        p["status"] = "escrow_authorised"
        p["captured_amount"] = 0
    else:
        p["status"] = "paid"
        p["captured_amount"] = p["amount"]


# ---------------------------------------------------------------- webhooks

@app.post("/webhook/invoice")
def webhook_invoice(payload: dict = Body(...)):
    from . import gate

    if not payload.get("invoice_id") or not payload.get("vendor_id"):
        raise HTTPException(422, "invoice_id and vendor_id are required")
    day = payload.get("day")
    day = int(day) if day is not None else store.day
    created_at = now_iso()
    if payload.get("days_ago") is not None:
        # Demo data: backdate the invoice within the 30-day window (day 29 = today).
        from datetime import datetime, timedelta, timezone
        hh, mm = (int(x) for x in str(payload.get("at", "10:00")).split(":"))
        ts = (datetime.now(timezone.utc) - timedelta(days=int(payload["days_ago"]))).replace(hour=hh, minute=mm, second=0, microsecond=0)
        created_at = ts.strftime("%Y-%m-%dT%H:%M:%SZ")
        day = seed.WINDOW_DAYS - 1 - int(payload["days_ago"])
    invoice = dict(payload, day=day)

    proposal = agent.propose(invoice)  # untrusted; may call Claude (outside the lock)
    if proposal.get("amount") is None:
        raise HTTPException(422, "no amount in the invoice and the agent proposed none")

    with store.lock:
        pol = active_policy()
        ev = gate.evaluate(proposal, store.snapshot_payments(), day, pol)
        vendor = seed.VENDORS.get(proposal["vendor_id"])
        po = seed.POS.get(proposal.get("po_id") or "")
        p = {
            "id": store.new_payment_id(), "created_at": created_at, "day": day,
            "invoice": invoice, "proposal": proposal,
            "vendor_name": vendor.name if vendor else str(proposal["vendor_id"]),
            "amount": proposal["amount"],
            "decision": ev["decision"], "deciding_rules": ev["deciding_rules"],
            "execute_as": ev.get("execute_as", "allow"),
            "status": None, "auto": False,
            "trace": ev["trace"], "verdict": ev.get("verdict", ""), "gate_verdict": ev.get("verdict", ""),
            "approvals": [],
            "stripe_pi_id": None, "stripe_status": None, "stripe_url": None,
            "captured_amount": None, "delivered_qty": None,
            "ordered_qty": po.ordered_qty if po else None,
            "policy_version": ev.get("policy_version", pol.version),
            "policy_hash": ev.get("policy_hash", pol.hash),
            "auto_spend_before": ev.get("auto_spend_before"),
        }
        d = ev["decision"]
        if d in ("allow", "escrow"):
            execute(p, d, auto=True)
        elif d == "hold":
            p["status"] = "held"
        else:
            p["status"] = "blocked"
        return store.add_payment(p)


@app.post("/webhook/delivery")
def webhook_delivery(body: dict = Body(...)):
    with store.lock:
        p = _get(str(body.get("payment_id")))
        if p["status"] != "escrow_authorised":
            raise HTTPException(409, f"payment is {p['status']}, not escrow_authorised")
        ordered = body.get("ordered_qty") or p.get("ordered_qty")
        if not ordered:
            raise HTTPException(422, "no ordered quantity known for this payment")
        ordered = int(ordered)
        try:
            delivered = int(body.get("delivered_qty"))
        except (TypeError, ValueError):
            raise HTTPException(422, "delivered_qty must be an integer")
        delivered = max(0, min(delivered, ordered))
        if delivered == 0:
            pi = stripe_client.cancel(p["stripe_pi_id"])
            p["status"] = "escrow_cancelled"
            p["captured_amount"] = 0
            note(p, f"0/{ordered} delivered, escrow cancelled, {gbp(p['amount'])} released")
        else:
            c = p["amount"] * delivered // ordered
            pi = stripe_client.capture(p["stripe_pi_id"], c)
            p["status"] = "escrow_captured"
            p["captured_amount"] = c
            note(p, f"{delivered}/{ordered} delivered, {gbp(c)} captured, {gbp(p['amount'] - c)} released")
        p["stripe_status"] = pi["status"]
        p["delivered_qty"] = delivered
        p["ordered_qty"] = ordered
        store.save()
        return p


# ---------------------------------------------------------------- payments

@app.get("/api/payments")
def list_payments():
    return store.list_payments()


@app.get("/api/payments/{payment_id}")
def get_payment(payment_id: str):
    return _get(payment_id)


def _approver(body: dict) -> str:
    who = (body or {}).get("approver")
    if who not in seed.APPROVERS:
        raise HTTPException(422, f"approver must be one of {sorted(seed.APPROVERS)}")
    return who


def _p12(po_id, approver: str) -> dict:
    try:
        from .rules import approval_check
        return approval_check(po_id, approver)
    except ImportError:
        po = seed.POS.get(po_id or "")
        if po and po.requester == approver:
            return {"ok": False, "reason": f"P12: {approver} requested {po.id}, so can't approve it"}
        return {"ok": True, "reason": f"approved by {approver}"}


@app.post("/api/payments/{payment_id}/approve")
def approve(payment_id: str, body: dict = Body(default={})):
    who = _approver(body)
    with store.lock:
        p = _get(payment_id)
        if p["status"] != "held":
            raise HTTPException(409, f"payment is {p['status']}, not held")
        check = _p12(p["proposal"].get("po_id"), who)
        p["approvals"].append({"approver": who, "ok": check["ok"], "reason": check["reason"],
                               "action": "approve", "at": now_iso()})
        if check["ok"]:
            execute(p, p.get("execute_as") or "allow", auto=False)
            if p["status"] == "paid":
                note(p, f"approved by {who}, paid")
            elif p["status"] == "escrow_authorised":
                note(p, f"approved by {who}, held in escrow")
        store.save()
        return p


@app.post("/api/payments/{payment_id}/reject")
def reject(payment_id: str, body: dict = Body(default={})):
    who = _approver(body)
    with store.lock:
        p = _get(payment_id)
        if p["status"] != "held":
            raise HTTPException(409, f"payment is {p['status']}, not held")
        p["approvals"].append({"approver": who, "ok": True, "reason": f"rejected by {who}",
                               "action": "reject", "at": now_iso()})
        p["status"] = "rejected"
        note(p, f"rejected by {who}")
        store.save()
        return p


# ---------------------------------------------------------------- summary / policy / prover / day

@app.get("/api/summary")
def get_summary():
    return summary()


@app.get("/api/policy")
def get_policy():
    return policy_view()


@app.post("/api/policy/version")
def set_policy_version(body: dict = Body(...)):
    version = body.get("version")
    if version not in _policy_mod().POLICIES:
        raise HTTPException(422, f"unknown policy version {version!r}")
    store.set_policy_version(version)
    if store.get_prove(version) is None and not os.environ.get("PROVEN_NO_PROVER"):
        runner.enqueue(version, front=True)
    return policy_view()


@app.get("/api/prove")
def get_prove(version: str | None = Query(default=None)):
    return prove_view(version or store.policy_version)


@app.post("/api/prove")
def post_prove(body: dict = Body(default={})):
    version = (body or {}).get("version") or store.policy_version
    if version not in VERSIONS:
        raise HTTPException(422, f"unknown policy version {version!r}")
    runner.enqueue(version, front=True)
    out = prove_view(version)
    out["running"] = True
    return out


@app.post("/api/day/advance")
def advance_day():
    store.advance_day()
    return summary()


@app.post("/api/reset")
def reset():
    store.reset()
    return summary()
