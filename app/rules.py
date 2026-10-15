"""Rule definitions P4-P12 (PLAN §5.2) plus P10_naive (§5.3).

Each rule's `fires` is written once against an `ops` object (ConcreteOps for the
gate, Z3Ops for the prover), using only ops.* and arithmetic/comparison
operators, so the proved policy is exactly the enforced one. `explain` is
concrete only and produces the numbers shown in the trace.
"""
from dataclasses import dataclass
from typing import Callable

from . import seed
from .ops import Ctx, Txn


@dataclass(frozen=True)
class Rule:
    id: str
    text: str
    decision: str        # allow | escrow | hold | block | approval (P12 only)
    condition: str
    fires: Callable
    explain: Callable


# ---------------------------------------------------------------- formatting

def fmt_gbp(pence) -> str:
    """Integer pence -> "£80", "£0.90", "£5,000", "£63.50"."""
    pence = int(pence)
    sign = "-" if pence < 0 else ""
    pence = abs(pence)
    pounds, p = divmod(pence, 100)
    if p:
        return f"{sign}£{pounds:,}.{p:02d}"
    return f"{sign}£{pounds:,}"


def _vname(vendor) -> str:
    v = seed.VENDORS.get(vendor)
    return v.name if v else f"unknown vendor {vendor!r}"


def _po_line(po_id) -> str:
    po = seed.POS[po_id]
    return (f"{po.id}: {_vname(po.vendor_id)}, received {po.received_qty} × "
            f"{fmt_gbp(po.unit_price)} = {fmt_gbp(po.limit)}")


def _hist_line(h: Txn, extra: str = "") -> str:
    state = "" if h.active else " (held, awaiting approval)"
    return f"history: {h.invoice} {fmt_gbp(h.amount)}{extra} on day {h.day}{state}"


def _cap_list(lines: list[str], n: int = 6) -> list[str]:
    if len(lines) <= n:
        return lines
    return lines[:n] + [f"... and {len(lines) - n} more"]


def _cmp(total, limit) -> str:
    return ">" if total > limit else "≤"


# Shared sub-expressions (ops-generic) --------------------------------------

def _po_known(p, ctx, ops):
    return ops.lookup(p.po, ctx.po_known, False)


def _vendor_today(p, hist, ops):
    return ops.Sum([ops.If(ops.And(h.active, h.vendor == p.vendor, h.day == p.day), h.amount, 0)
                    for h in hist])


def _auto_window(p, hist, ops):
    return ops.Sum([ops.If(ops.And(h.active, h.auto, h.day > p.day - seed.WINDOW_DAYS), h.amount, 0)
                    for h in hist])


def _paid_against(p, hist, ops):
    return ops.Sum([ops.If(ops.And(h.active, h.po == p.po), h.amount, 0) for h in hist])


# ---------------------------------------------------------------- P4

def p4_fires(p, hist, ctx, ops):
    return ops.Or(*[ops.And(ops.Or(h.active, h.pending), h.invoice == p.invoice) for h in hist])


def p4_explain(p, hist, ctx):
    hits = [h for h in hist if (h.active or h.pending) and h.invoice == p.invoice]
    if not hits:
        return {"detail": f"{p.invoice} not seen before", "evidence": []}
    h = hits[0]
    what = (f"already paid ({fmt_gbp(h.amount)} on day {h.day})" if h.active
            else f"already held awaiting approval ({fmt_gbp(h.amount)} on day {h.day})")
    return {"detail": f"{p.invoice} {what}", "evidence": [_hist_line(x) for x in hits]}


# ---------------------------------------------------------------- P5 / P6

MAX_SINGLE = 500_00
APPROVAL_SINGLE = 100_00


def p5_fires(p, hist, ctx, ops):
    return p.amount > MAX_SINGLE


def p5_explain(p, hist, ctx):
    return {"detail": f"{fmt_gbp(p.amount)} {_cmp(p.amount, MAX_SINGLE)} {fmt_gbp(MAX_SINGLE)}",
            "evidence": [f"proposal: {p.invoice} {fmt_gbp(p.amount)} to {_vname(p.vendor)}"]}


def p6_fires(p, hist, ctx, ops):
    return p.amount > APPROVAL_SINGLE


def p6_explain(p, hist, ctx):
    return {"detail": f"{fmt_gbp(p.amount)} {_cmp(p.amount, APPROVAL_SINGLE)} {fmt_gbp(APPROVAL_SINGLE)}",
            "evidence": [f"proposal: {p.invoice} {fmt_gbp(p.amount)} to {_vname(p.vendor)}"]}


# ---------------------------------------------------------------- P7

DAILY_VENDOR = 100_00


def p7_fires(p, hist, ctx, ops):
    return _vendor_today(p, hist, ops) + p.amount > DAILY_VENDOR


def p7_explain(p, hist, ctx):
    hits = [h for h in hist if h.active and h.vendor == p.vendor and h.day == p.day]
    before = sum(h.amount for h in hits)
    total = before + p.amount
    return {"detail": (f"{_vname(p.vendor)} already received {fmt_gbp(before)} today (day {p.day}); "
                       f"{fmt_gbp(before)} + {fmt_gbp(p.amount)} = {fmt_gbp(total)} "
                       f"{_cmp(total, DAILY_VENDOR)} {fmt_gbp(DAILY_VENDOR)}"),
            "evidence": _cap_list([_hist_line(h) for h in hits])}


# ---------------------------------------------------------------- P8

def p8_fires(p, hist, ctx, ops):
    return _auto_window(p, hist, ops) + p.amount > seed.AUTO_CAP


def p8_explain(p, hist, ctx):
    hits = [h for h in hist if h.active and h.auto and h.day > p.day - seed.WINDOW_DAYS]
    before = sum(h.amount for h in hits)
    total = before + p.amount
    return {"detail": (f"unapproved spend in the last 30 days {fmt_gbp(before)}; "
                       f"{fmt_gbp(before)} + {fmt_gbp(p.amount)} = {fmt_gbp(total)} "
                       f"{_cmp(total, seed.AUTO_CAP)} {fmt_gbp(seed.AUTO_CAP)}"),
            "evidence": _cap_list([_hist_line(h, " (auto)") for h in hits])}


# ---------------------------------------------------------------- P9

def p9_fires(p, hist, ctx, ops):
    return ops.Or(p.po == ctx.no_po,
                  ops.Not(_po_known(p, ctx, ops)),
                  ops.lookup(p.po, ctx.po_vendor, ctx.no_vendor) != p.vendor)


def p9_explain(p, hist, ctx):
    if p.po in (None, "", ctx.no_po):
        return {"detail": "no purchase order on the invoice", "evidence": []}
    po = seed.POS.get(p.po)
    if po is None:
        return {"detail": f"{p.po} is not a known purchase order", "evidence": []}
    if po.vendor_id != p.vendor:
        return {"detail": f"{p.po} belongs to {_vname(po.vendor_id)}, not {_vname(p.vendor)}",
                "evidence": [_po_line(p.po)]}
    return {"detail": f"{p.po} matches {_vname(p.vendor)}", "evidence": [_po_line(p.po)]}


# ---------------------------------------------------------------- P10 / P10_naive

def p10_fires(p, hist, ctx, ops):
    limit = ops.lookup(p.po, ctx.po_limit, 0)
    return ops.And(_po_known(p, ctx, ops), _paid_against(p, hist, ops) + p.amount > limit)


def p10_explain(p, hist, ctx):
    po = seed.POS.get(p.po)
    if po is None:
        return {"detail": "no known purchase order, so no PO limit applies (see P9)", "evidence": []}
    hits = [h for h in hist if h.active and h.po == p.po]
    before = sum(h.amount for h in hits)
    total = before + p.amount
    return {"detail": (f"paid against {po.id} {fmt_gbp(before)} + {fmt_gbp(p.amount)} = {fmt_gbp(total)} "
                       f"{_cmp(total, po.limit)} {fmt_gbp(po.limit)} "
                       f"(received {po.received_qty} × {fmt_gbp(po.unit_price)})"),
            "evidence": [_po_line(po.id)] + _cap_list([_hist_line(h, f" against {po.id}") for h in hits])}


def p10_naive_fires(p, hist, ctx, ops):
    return ops.And(_po_known(p, ctx, ops), p.amount > ops.lookup(p.po, ctx.po_limit, 0))


def p10_naive_explain(p, hist, ctx):
    po = seed.POS.get(p.po)
    if po is None:
        return {"detail": "no known purchase order, so no PO limit applies (see P9)", "evidence": []}
    return {"detail": (f"this invoice alone: {fmt_gbp(p.amount)} {_cmp(p.amount, po.limit)} {fmt_gbp(po.limit)} "
                       f"(received {po.received_qty} × {fmt_gbp(po.unit_price)}); earlier payments not counted"),
            "evidence": [_po_line(po.id)]}


# ---------------------------------------------------------------- P11

ESCROW_OVER = 50_00


def p11_fires(p, hist, ctx, ops):
    return ops.And(ops.lookup(p.vendor, ctx.vendor_is_agent, False), p.amount > ESCROW_OVER)


def p11_explain(p, hist, ctx):
    v = seed.VENDORS.get(p.vendor)
    if v is None or not v.is_agent:
        return {"detail": f"{_vname(p.vendor)} is not an AI agent", "evidence": []}
    return {"detail": (f"{v.name} is an AI agent; {fmt_gbp(p.amount)} "
                       f"{_cmp(p.amount, ESCROW_OVER)} {fmt_gbp(ESCROW_OVER)}"),
            "evidence": [f"vendor: {v.name} (is_agent = true)"]}


# ---------------------------------------------------------------- P12 (approval time only)

def p12_fires(p, hist, ctx, ops):
    # Never evaluated by the gate or the prover: P12 is checked when someone approves.
    return ops.Or()


def p12_explain(p, hist, ctx):
    po = seed.POS.get(p.po)
    if po is None:
        return {"detail": "checked at approval time (no PO, so no requester)", "evidence": []}
    return {"detail": f"checked at approval time: {po.requester} requested {po.id} and can't approve it",
            "evidence": [f"{po.id}: requested by {po.requester}"]}


def approval_check(po_id, approver: str) -> dict:
    """P12 at approval time -> {"ok": bool, "reason": str}."""
    po = seed.POS.get(po_id) if po_id else None
    if po is not None and po.requester == approver:
        return {"ok": False, "reason": f"P12: {approver} requested {po.id}, so can't approve it"}
    who = f"{po.id} was requested by {po.requester}" if po else "no PO requester"
    return {"ok": True, "reason": f"P12 passed: {who}, approved by {approver}"}


# ---------------------------------------------------------------- registry

RULES: dict[str, Rule] = {r.id: r for r in [
    Rule("P4", "Never pay the same invoice twice", "block",
         "p.invoice_id ∈ {h.invoice_id : h executed ∨ h held}", p4_fires, p4_explain),
    Rule("P5", "No single payment over £500", "block",
         "p.amount > £500", p5_fires, p5_explain),
    Rule("P6", "Payments over £100 need approval", "hold",
         "p.amount > £100", p6_fires, p6_explain),
    Rule("P7", "Over £100 to one vendor in one day needs approval", "hold",
         "Σ(h executed: vendor = p.vendor ∧ day = p.day) + p.amount > £100", p7_fires, p7_explain),
    Rule("P8", "Unapproved spend capped at £5,000 per 30 days", "hold",
         "Σ(h executed ∧ auto: day > p.day − 30) + p.amount > £5,000", p8_fires, p8_explain),
    Rule("P9", "Every payment needs a matching purchase order", "hold",
         "p.po missing ∨ unknown ∨ po.vendor ≠ p.vendor", p9_fires, p9_explain),
    Rule("P10", "Never pay more than what arrived, at the contract price", "block",
         "paid_against(po) + p.amount > po.received_qty × po.unit_price", p10_fires, p10_explain),
    Rule("P10_naive", "Never pay more than what arrived (this invoice alone)", "block",
         "p.amount > po.received_qty × po.unit_price", p10_naive_fires, p10_naive_explain),
    Rule("P11", "Buying from another agent over £50 goes through escrow", "escrow",
         "vendor.is_agent ∧ p.amount > £50", p11_fires, p11_explain),
    Rule("P12", "Whoever requested the PO can't approve the payment", "approval",
         "at approval: approver ≠ po.requester", p12_fires, p12_explain),
]}
