"""The deterministic gate: proposal + payment history -> decision, trace and verdict."""
from . import seed
from .ops import ConcreteOps, Ctx, Txn
from .policy import SEV, decide, get_policy, rules_of
from .rules import fmt_gbp  # noqa: F401  (re-exported: gate.fmt_gbp)

EXECUTED = {"paid", "escrow_authorised", "escrow_captured"}

_CTX = Ctx.concrete()

_VERB = {"allow": "Paid", "escrow": "Escrow", "hold": "Held", "block": "Blocked"}


def _po(po_id):
    return po_id if po_id else _CTX.no_po


def _amount(payment: dict) -> int:
    if payment.get("status") == "escrow_captured" and payment.get("captured_amount") is not None:
        return int(payment["captured_amount"])
    prop = payment.get("proposal") or {}
    return int(prop.get("amount") if prop.get("amount") is not None else payment.get("amount") or 0)


def history_from_payments(payments: list[dict]) -> list[Txn]:
    hist = []
    for pay in payments:
        status = pay.get("status")
        if status in EXECUTED:
            active, pending, auto = True, False, bool(pay.get("auto"))
        elif status == "held":
            active, pending, auto = False, True, False
        else:
            continue
        prop = pay.get("proposal") or {}
        hist.append(Txn(invoice=prop.get("invoice_id"), vendor=prop.get("vendor_id"),
                        amount=_amount(pay), po=_po(prop.get("po_id")), day=int(pay.get("day", 0)),
                        active=active, auto=auto, pending=pending,
                        key=prop.get("api_key"), nights=int(prop.get("nights") or 0)))
    return hist


def proposal_txn(proposal: dict, day: int) -> Txn:
    return Txn(invoice=proposal.get("invoice_id"), vendor=proposal.get("vendor_id"),
               amount=int(proposal.get("amount") or 0), po=_po(proposal.get("po_id")), day=int(day),
               key=proposal.get("api_key"), nights=int(proposal.get("nights") or 0))


def _join(ids: list[str]) -> str:
    return ids[0] if len(ids) == 1 else ", ".join(ids[:-1]) + " and " + ids[-1]


def evaluate(proposal: dict, payments: list[dict], day: int, policy) -> dict:
    policy = get_policy(policy)
    p = proposal_txn(proposal, day)
    hist = history_from_payments(payments)
    rules = rules_of(policy)

    trace = []
    for r in rules:
        f = bool(r.fires(p, hist, _CTX, ConcreteOps))
        ex = r.explain(p, hist, _CTX)
        trace.append({"rule_id": r.id, "text": r.text, "decision": r.decision, "fired": f,
                      "detail": ex["detail"], "evidence": list(ex.get("evidence", []))})

    sev = decide(policy, p, hist, _CTX, ConcreteOps)
    decision = {v: k for k, v in SEV.items()}[sev]
    deciding = [t for t in trace if t["fired"] and SEV[t["decision"]] == sev] if sev else []
    deciding_ids = [t["rule_id"] for t in deciding]
    execute_as = "escrow" if any(t["fired"] and t["decision"] == "escrow" for t in trace) else "allow"

    if not deciding:
        verdict = f"Paid: passed all {len(rules)} rules."
    else:
        verdict = (f"{_VERB[decision]} by {_join(deciding_ids)}: "
                   + "; ".join(t["detail"] for t in deciding) + ".")

    auto_before = sum(h.amount for h in hist
                      if h.active and h.auto and p.day - seed.WINDOW_DAYS < h.day <= p.day)

    return {
        "decision": decision,
        "deciding_rules": deciding_ids,
        "execute_as": execute_as,
        "trace": trace,
        "verdict": verdict,
        "auto_spend_before": auto_before,
        "policy_version": policy.version,
        "policy_hash": policy.hash,
    }
