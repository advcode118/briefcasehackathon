"""The proved policy is the enforced policy.

For random concrete histories and proposals, the decision computed with
ConcreteOps (the gate) must equal the decision computed with Z3Ops (the prover)
on the same values encoded as Z3 constants under Ctx.symbolic(), after z3.simplify.
"""
import random

import pytest
import z3

from app import seed
from app.ops import ConcreteOps, Ctx, Txn, Z3Ops
from app.policy import POLICIES, decide, fired

VENDORS = list(seed.VENDORS) + ["evilco"]          # one unknown vendor
POS = list(seed.POS) + ["PO-99", None]              # one unknown PO, and no PO
INVOICES = [f"INV-{i:03d}" for i in range(8)]       # small pool -> duplicates

CCTX = Ctx.concrete()
SCTX = Ctx.symbolic()


class Encoder:
    """Maps concrete ids to the integer encoding the prover uses."""

    def __init__(self):
        self.vendor = {v: i for i, v in enumerate(SCTX.vendor_ids)}
        self.po = {p: i for i, p in enumerate(SCTX.po_ids)}
        self.po[None] = SCTX.no_po
        self.inv = {}

    def _get(self, table, key, base):
        if key not in table:
            table[key] = base + len(table)
        return table[key]

    def txn(self, t: Txn) -> Txn:
        return Txn(
            invoice=z3.IntVal(self._get(self.inv, t.invoice, 0)),
            vendor=z3.IntVal(self._get(self.vendor, t.vendor, 100)),
            amount=z3.IntVal(t.amount),
            po=z3.IntVal(self._get(self.po, t.po, 100)),
            day=z3.IntVal(t.day),
            active=z3.BoolVal(t.active),
            auto=z3.BoolVal(t.auto),
            pending=z3.BoolVal(t.pending),
        )


def _amount(rng):
    r = rng.random()
    if r < 0.5:
        return rng.randint(1, 10_000_00)
    if r < 0.85:
        return rng.randint(10_000_00, 60_000_00)
    return rng.choice([500_00, 1_000_00, 2_500_00, 5_000_00, 8_000_00, 9_900_00, 10_000_00, 50_000_00, 900_000_00])


def _txn(rng, day_hi):
    status = rng.choice(["active", "active", "active", "pending", "none"])
    active = status == "active"
    return Txn(
        invoice=rng.choice(INVOICES),
        vendor=rng.choice(VENDORS),
        amount=_amount(rng),
        po=rng.choice(POS),
        day=rng.randint(0, day_hi),
        active=active,
        auto=active and rng.random() < 0.7,
        pending=status == "pending",
    )


def _case(rng):
    day = rng.randint(0, 40)
    hist = [_txn(rng, day) for _ in range(rng.randint(0, 18))]
    # bias some histories to the proposal's day / vendor to exercise P7
    p = _txn(rng, day)
    p = Txn(p.invoice, p.vendor, p.amount, p.po, day)
    if rng.random() < 0.5:  # matching vendor/PO pairs, so allow/escrow and category rules occur
        po = rng.choice(list(seed.POS))
        p = Txn(p.invoice, seed.POS[po].vendor_id, rng.randint(1, 10_000_00), po, day)
    for h in hist:
        if rng.random() < 0.3:
            h.day, h.vendor = day, p.vendor
    return p, hist


HANDPICKED = [
    # unknown vendor, no PO
    (Txn("INV-100", "evilco", 80_00, None, 1), []),
    # unknown PO
    (Txn("INV-100", "cloudco", 80_00, "PO-99", 1), []),
    # PO belongs to another vendor
    (Txn("INV-100", "cloudco", 80_00, "PO-2", 1), []),
    # duplicate of an executed payment
    (Txn("INV-001", "cloudco", 80_00, "PO-1", 1), [Txn("INV-001", "cloudco", 80_00, "PO-1", 1, True, True)]),
    # duplicate of a held payment
    (Txn("INV-002", "cloudco", 20_00, "PO-1", 2),
     [Txn("INV-002", "cloudco", 80_00, "PO-1", 1, active=False, auto=False, pending=True)]),
    # PO overpay across two invoices (naive P10 passes, P10 blocks)
    (Txn("INV-201", "cloudco", 90_00, "PO-1", 5), [Txn("INV-200", "cloudco", 150_00, "PO-1", 3, True, False)]),
    # agent vendor -> escrow
    (Txn("INV-300", "labelbot", 90, "PO-3", 2), []),
    (Txn("INV-301", "labelbot", 90_00, "PO-3", 2), []),
    # auto cap
    (Txn("INV-400", "cloudco", 10_00, "PO-1", 29),
     [Txn(f"INV-4{i:02d}", "quickfix", 100_00, None, i % 30, True, True) for i in range(1, 51)]),
    # nothing fires
    (Txn("INV-500", "cloudco", 10_00, "PO-1", 0), []),
    # AI-agent vendor over the escrow threshold, matching PO
    (Txn("INV-600", "lexa", 9_000_00, "PO-104", 3), []),
]


def _cases():
    rng = random.Random(1234)
    return HANDPICKED + [_case(rng) for _ in range(200)]


@pytest.mark.parametrize("version", list(POLICIES))
def test_concrete_equals_z3(version):
    pol = POLICIES[version]
    seen = set()
    for p, hist in _cases():
        c = decide(pol, p, hist, CCTX, ConcreteOps)
        enc = Encoder()
        zp, zh = enc.txn(p), [enc.txn(h) for h in hist]
        s = z3.simplify(decide(pol, zp, zh, SCTX, Z3Ops))
        assert z3.is_int_value(s), s
        assert c == s.as_long(), (version, p, hist)

        cf = fired(pol, p, hist, CCTX, ConcreteOps)
        zf = fired(pol, zp, zh, SCTX, Z3Ops)
        for rid in cf:
            zv = z3.simplify(z3.BoolVal(zf[rid]) if isinstance(zf[rid], bool) else zf[rid])
            assert z3.is_true(zv) or z3.is_false(zv), (rid, zv)
            assert bool(cf[rid]) == z3.is_true(zv), (version, rid, p, hist)
        seen.add(c)
    # the random set covers every decision level
    assert seen == {0, 1, 2, 3}, seen
