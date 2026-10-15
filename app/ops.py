"""Shared semantics: every rule is written once against an `ops` object.

ConcreteOps evaluates rules on real payments (the gate). Z3Ops builds the same
rules as Z3 terms (the prover). Same code, so the proved policy is the enforced one.
"""
from dataclasses import dataclass, field

import z3

from . import seed


class ConcreteOps:
    symbolic = False

    @staticmethod
    def If(c, a, b):
        return a if c else b

    @staticmethod
    def And(*xs):
        return all(xs)

    @staticmethod
    def Or(*xs):
        return any(xs)

    @staticmethod
    def Not(x):
        return not x

    @staticmethod
    def Sum(xs):
        return sum(xs)

    @staticmethod
    def Max(a, b):
        return a if a >= b else b

    @staticmethod
    def lookup(key, table: dict, default):
        return table.get(key, default)


class Z3Ops:
    symbolic = True

    @staticmethod
    def If(c, a, b):
        return z3.If(c, a, b)

    @staticmethod
    def And(*xs):
        return z3.And(*xs) if xs else z3.BoolVal(True)

    @staticmethod
    def Or(*xs):
        return z3.Or(*xs) if xs else z3.BoolVal(False)

    @staticmethod
    def Not(x):
        return z3.Not(x)

    @staticmethod
    def Sum(xs):
        xs = list(xs)
        return z3.Sum(xs) if xs else z3.IntVal(0)

    @staticmethod
    def Max(a, b):
        return z3.If(a >= b, a, b)

    @staticmethod
    def lookup(key, table: dict, default):
        expr = default
        for k, v in table.items():
            expr = z3.If(key == k, v, expr)
        return expr


@dataclass
class Txn:
    """A proposal or a history item. Concrete: str ids / int pence. Symbolic: Z3 Ints/Bools."""
    invoice: object
    vendor: object
    amount: object
    po: object                # ctx.no_po when the invoice has no PO
    day: object
    active: object = True     # executed (paid / escrow_authorised / escrow_captured)
    auto: object = False      # executed without a human
    pending: object = False   # held awaiting approval (always False in the prover)


@dataclass
class Ctx:
    """Static lookup tables the rules read. Keys are str ids (concrete) or int indices (symbolic)."""
    no_po: object
    no_vendor: object
    po_limit: dict = field(default_factory=dict)        # po -> received_qty * unit_price
    po_vendor: dict = field(default_factory=dict)       # po -> vendor
    po_known: dict = field(default_factory=dict)        # po -> True
    vendor_is_agent: dict = field(default_factory=dict) # vendor -> bool
    po_category: dict = field(default_factory=dict)     # po -> category (str concrete, index symbolic)
    category: dict = field(default_factory=dict)        # category name -> key used in po_category
    vendor_ids: list = field(default_factory=list)      # symbolic: index -> str id
    po_ids: list = field(default_factory=list)          # symbolic: index -> str id

    @classmethod
    def concrete(cls) -> "Ctx":
        return cls(
            no_po=None,
            no_vendor=None,
            po_limit={po.id: po.limit for po in seed.POS.values()},
            po_vendor={po.id: po.vendor_id for po in seed.POS.values()},
            po_known={po.id: True for po in seed.POS.values()},
            vendor_is_agent={v.id: v.is_agent for v in seed.VENDORS.values()},
            po_category={po.id: po.category for po in seed.POS.values()},
            category={c: c for c in seed.CATEGORIES},
        )

    @classmethod
    def symbolic(cls) -> "Ctx":
        """Vendors and POs become int indices; -1 means 'no PO' / 'no vendor'."""
        vendor_ids = list(seed.VENDORS)
        po_ids = list(seed.POS)
        vi = {v: i for i, v in enumerate(vendor_ids)}
        return cls(
            no_po=-1,
            no_vendor=-1,
            po_limit={i: seed.POS[p].limit for i, p in enumerate(po_ids)},
            po_vendor={i: vi[seed.POS[p].vendor_id] for i, p in enumerate(po_ids)},
            po_known={i: True for i in range(len(po_ids))},
            vendor_is_agent={i: seed.VENDORS[v].is_agent for i, v in enumerate(vendor_ids)},
            po_category={i: (seed.CATEGORIES.index(seed.POS[p].category) if seed.POS[p].category in seed.CATEGORIES else -1)
                         for i, p in enumerate(po_ids)},
            category={c: i for i, c in enumerate(seed.CATEGORIES)},
            vendor_ids=vendor_ids,
            po_ids=po_ids,
        )
