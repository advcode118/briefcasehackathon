"""Z3 prover: theorems about the spending policy (PLAN §6).

Every slot decision comes from `policy.decide(..., Z3Ops)`, the same rule code the
gate runs with ConcreteOps. Nothing here re-implements a rule: the prover only adds
the bounded model (N payment slots in one 30-day window) and the theorem negations.

UNSAT on a negation = proved (for <= N payments per 30 days, against the seed POs).
SAT = attack; the model's active slots are returned as the counterexample.
"""
from __future__ import annotations

import time
from dataclasses import dataclass

import z3

from . import seed
from .ops import Ctx, Txn, Z3Ops

BLOCK, HOLD, ESCROW, ALLOW = 3, 2, 1, 0
SEV_NAME = {0: "allow", 1: "escrow", 2: "hold", 3: "block"}

MAX_AMOUNT = 500_00          # P5: a single payment never exceeds this, so slots range over [1, 500_00]
DAILY_CAP = 100_00           # T2 / P7
DAYS = seed.WINDOW_DAYS      # one 30-day window: day in [0, 29]
DEFAULT_N = 60               # must stay >= 51 so that N x £100 > £5,000 (PLAN §6.1 bound rule)
T7_HISTORY = 10              # M history slots for the no-over-blocking theorem
CHECK_TIMEOUT_MS = 60_000    # per theorem
OPT_TIMEOUT_MS = 40_000      # worst-case (bounds + witness search + Optimize fallback)

THEOREMS = {
    "T1": "Unapproved spend in 30 days ≤ £5,000",
    "T2": "No vendor gets > £100 in a day without approval",
    "T3": "No invoice is ever paid twice",
    "T5": "Total paid against any PO ≤ received × contract price",
    "T6": "Escrow conserves money",
    "T7": "A valid invoice is always paid automatically (no over-blocking)",
    "T8": "This policy allows nothing the final CFO policy (v4) blocks",
}
P0 = ["T1", "T2", "T3", "T5"]
P1 = ["T6", "T7", "T8"]


def _policy_mod():
    from . import policy  # imported lazily: WS A owns it
    return policy


def gbp(pence: int) -> str:
    pounds, p = divmod(int(pence), 100)
    return f"£{pounds:,}" if p == 0 else f"£{pounds:,}.{p:02d}"


def escrow_capture(amount, delivered, ordered):
    """Partial capture on delivery: amount x delivered / ordered, rounded down.
    Works on ints (gate/backend) and Z3 Ints (prover, where `/` is integer division)."""
    if isinstance(amount, int) and isinstance(delivered, int) and isinstance(ordered, int):
        return amount * delivered // ordered
    return (amount * delivered) / ordered


# --------------------------------------------------------------------------- slot model

@dataclass
class SlotModel:
    n: int
    ctx: Ctx
    slots: list          # Txn with Z3 fields
    decisions: list      # Z3 Int per slot, from policy.decide
    base: list           # bounds, ordering, decision constraints (over the named rule firings)
    defs: list           # (fires_Bool, rule fires expr): names each rule firing
    clean: bool = True   # every slot uses the verified max-severity form

    @property
    def constraints(self) -> list:
        """The full bounded model (base + every rule-firing definition)."""
        return self.base + [b == f for b, f in self.defs]


def _slot_vars(prefix: str, i: int, ctx: Ctx, constraints: list) -> Txn:
    nv, npo = len(ctx.vendor_ids), len(ctx.po_ids)
    t = Txn(
        invoice=z3.Int(f"{prefix}inv_{i}"),
        vendor=z3.Int(f"{prefix}vend_{i}"),
        amount=z3.Int(f"{prefix}amt_{i}"),
        po=z3.Int(f"{prefix}po_{i}"),
        day=z3.Int(f"{prefix}day_{i}"),
        active=z3.Bool(f"{prefix}active_{i}"),
        auto=z3.Bool(f"{prefix}auto_{i}"),
        pending=False,
    )
    constraints += [
        t.amount >= 1, t.amount <= MAX_AMOUNT,
        t.day >= 0, t.day <= DAYS - 1,
        t.vendor >= 0, t.vendor <= nv - 1,
        t.po >= ctx.no_po, t.po <= npo - 1,
    ]
    return t


def _slot_decision(pol_mod, pol, t: Txn, hist: list, ctx: Ctx, tag: str, bounds=None):
    """Decision of one slot, straight from policy.decide, with each rule's firing
    condition (from policy.fired, i.e. the rule code) named by a fresh Bool.

    decide's Max/If chain is rewritten over those Bools and then checked, by Z3,
    to equal the plain max-severity form If(any block, 3, If(any hold, 2, ...)).
    Only if that equivalence is proved is the clean form used (much faster to
    solve); otherwise the raw decide expression is used as is. Either way the
    slot's decision is exactly policy.decide's.
    Returns (decision expr, [(Bool, fires expr)], clean)."""
    raw = pol_mod.decide(pol, t, hist, ctx, Z3Ops)
    fires = pol_mod.fired(pol, t, hist, ctx, Z3Ops)
    sev = {r.id: pol_mod.SEV[r.decision] for r in pol_mod.rules_of(pol)}
    bs, pairs, defs = {}, [], []
    for rid, f in fires.items():
        if not isinstance(f, z3.BoolRef):
            f = z3.BoolVal(bool(f))
        if z3.is_true(f) or z3.is_false(f):
            bs[rid] = f
            continue
        b = z3.Bool(f"{tag}fires_{rid}")
        bs[rid] = b
        pairs.append((f, b))
        if bounds is not None:
            f = bound_simplify(f, bounds)
        defs.append((b, f))
    abstract = z3.substitute(raw, *pairs) if pairs else raw

    def any_of(level):
        return z3.Or([bs[r] for r in bs if sev[r] == level] or [z3.BoolVal(False)])

    clean = z3.If(any_of(BLOCK), BLOCK, z3.If(any_of(HOLD), HOLD, z3.If(any_of(ESCROW), ESCROW, ALLOW)))
    chk = z3.Solver()
    chk.set("timeout", 5000)
    chk.add(abstract != clean)
    if chk.check() == z3.unsat:
        return clean, defs, True
    return raw, [], False


_INF = float("inf")


def _bounds_of(ctx: Ctx) -> dict:
    """Variable bounds asserted by _slot_vars, keyed by variable-name stem."""
    return {"amt": (1, MAX_AMOUNT), "day": (0, DAYS - 1), "vend": (0, len(ctx.vendor_ids) - 1),
            "po": (ctx.no_po, len(ctx.po_ids) - 1)}


def _interval(e, bounds, memo):
    k = e.get_id()
    if k in memo:
        return memo[k]
    lo, hi = -_INF, _INF
    if z3.is_int_value(e):
        lo = hi = e.as_long()
    elif z3.is_const(e) and e.num_args() == 0:
        stem = str(e).rsplit("_", 1)[0].split("_")[-1]
        lo, hi = bounds.get(stem, (-_INF, _INF))
    elif z3.is_add(e):
        lo = hi = 0
        for c in e.children():
            a, b = _interval(c, bounds, memo)
            lo, hi = lo + a, hi + b
    elif z3.is_sub(e):
        cs = e.children()
        lo, hi = _interval(cs[0], bounds, memo)
        for c in cs[1:]:
            a, b = _interval(c, bounds, memo)
            lo, hi = lo - b, hi - a
    elif z3.is_mul(e) and e.num_args() == 2 and z3.is_int_value(e.arg(0)):
        k0 = e.arg(0).as_long()
        a, b = _interval(e.arg(1), bounds, memo)
        lo, hi = sorted((k0 * a, k0 * b)) if k0 else (0, 0)
    elif z3.is_app_of(e, z3.Z3_OP_ITE):
        a1, b1 = _interval(e.arg(1), bounds, memo)
        a2, b2 = _interval(e.arg(2), bounds, memo)
        lo, hi = min(a1, a2), max(b1, b2)
    memo[k] = (lo, hi)
    return lo, hi


_CMP = {z3.Z3_OP_LT: lambda lo, hi: (hi < 0, lo >= 0), z3.Z3_OP_LE: lambda lo, hi: (hi <= 0, lo > 0),
        z3.Z3_OP_GT: lambda lo, hi: (lo > 0, hi <= 0), z3.Z3_OP_GE: lambda lo, hi: (lo >= 0, hi < 0),
        z3.Z3_OP_EQ: lambda lo, hi: (lo == hi == 0, lo > 0 or hi < 0),
        z3.Z3_OP_DISTINCT: lambda lo, hi: (lo > 0 or hi < 0, lo == hi == 0)}


def bound_simplify(expr, bounds: dict):
    """Replace comparison atoms that the slot variables' bounds already decide by
    True/False (e.g. P8's `h.day > p.day - 30` when every day is in [0, 29]), then
    z3.simplify. Equivalent under the bounds, which the model asserts anyway."""
    imemo, rmemo = {}, {}

    def rw(e):
        k = e.get_id()
        if k in rmemo:
            return rmemo[k]
        out = e
        if z3.is_app(e) and e.num_args() > 0:
            op = e.decl().kind()
            if op in _CMP and e.num_args() == 2 and e.arg(0).sort() == z3.IntSort():
                a1, b1 = _interval(e.arg(0), bounds, imemo)
                a2, b2 = _interval(e.arg(1), bounds, imemo)
                t, f = _CMP[op](a1 - b2, b1 - a2)
                if t:
                    out = z3.BoolVal(True)
                elif f:
                    out = z3.BoolVal(False)
            if out is e:
                kids = [rw(c) for c in e.children()]
                if any(a.get_id() != b.get_id() for a, b in zip(kids, e.children())):
                    out = e.decl()(*kids)
        rmemo[k] = out
        return out

    return z3.simplify(rw(expr))


def build_slots(version: str, n: int = DEFAULT_N) -> SlotModel:
    """N payment slots. decision_i = policy.decide(slot_i, slots[:i]).
    active_i => decision_i != block; auto_i => active_i and decision_i in {allow, escrow}.
    Active slots form a prefix (symmetry breaking: every rule filters history by
    h.active, so inactive slots never influence a decision and can be moved last)."""
    pol_mod = _policy_mod()
    pol = pol_mod.get_policy(version)
    ctx = Ctx.symbolic()
    cons: list = []
    defs: list = []
    slots: list[Txn] = []
    decs: list = []
    clean_all = True
    for i in range(n):
        t = _slot_vars("", i, ctx, cons)
        d = z3.Int(f"dec_{i}")
        dexpr, sdefs, clean = _slot_decision(pol_mod, pol, t, slots, ctx, f"s{i}_", _bounds_of(ctx))
        clean_all &= clean
        defs += sdefs
        cons.append(d == dexpr)
        cons.append(z3.Implies(t.active, d != BLOCK))
        cons.append(z3.Implies(t.auto, z3.And(t.active, d <= ESCROW)))
        if slots:
            cons.append(t.day >= slots[-1].day)
            cons.append(z3.Implies(t.active, slots[-1].active))
        slots.append(t)
        decs.append(d)
    return SlotModel(n, ctx, slots, decs, cons, defs, clean_all)


def _solve(sm: SlotModel, extra: list, timeout_ms: int):
    s = z3.Solver()
    s.set("timeout", timeout_ms)
    s.add(sm.constraints + extra)
    r = s.check()
    return r, (s.model() if r == z3.sat else None)


# --------------------------------------------------------------------------- counterexamples

def _ival(m, e) -> int:
    return m.eval(e, model_completion=True).as_long()


def _bval(m, e) -> bool:
    return z3.is_true(m.eval(e, model_completion=True))


def _extract(m, sm: SlotModel) -> list[dict]:
    """Active slots in order. Invoice ids are renumbered 1, 2, ... by first appearance
    (the rules only compare invoice ids for equality, so this preserves the attack)."""
    out, inv_map = [], {}
    for t, d in zip(sm.slots, sm.decisions):
        if not _bval(m, t.active):
            continue
        po = _ival(m, t.po)
        inv = inv_map.setdefault(_ival(m, t.invoice), len(inv_map) + 1)
        out.append({
            "day": _ival(m, t.day),
            "vendor": sm.ctx.vendor_ids[_ival(m, t.vendor)],
            "po": None if po == sm.ctx.no_po else sm.ctx.po_ids[po],
            "amount": _ival(m, t.amount),
            "invoice_id": inv,
            "auto": _bval(m, t.auto),
            "decision": SEV_NAME[_ival(m, d)],
        })
    return out


def _vendors_phrase(pays) -> str:
    vs = {p["vendor"] for p in pays}
    return f"{len(vs)} vendor" + ("" if len(vs) == 1 else "s")


def _summary(tid: str, pays: list[dict]) -> str:
    auto = [p for p in pays if p["auto"]]
    if tid == "T1":
        tot = sum(p["amount"] for p in auto)
        return (f"{gbp(tot)} unapproved in 30 days via {len(auto)} payments "
                f"across {_vendors_phrase(auto)}")
    if tid == "T2":
        groups: dict = {}
        for p in auto:
            groups.setdefault((p["vendor"], p["day"]), []).append(p)
        (v, d), ps = max(groups.items(), key=lambda kv: sum(p["amount"] for p in kv[1]))
        return (f"{gbp(sum(p['amount'] for p in ps))} unapproved to {v} on day {d} via "
                f"{len(ps)} payments, each ≤ £100")
    if tid == "T3":
        seen: dict = {}
        for p in pays:
            if p["invoice_id"] in seen:
                q = seen[p["invoice_id"]]
                return (f"Invoice #{p['invoice_id']} paid twice: {gbp(q['amount'])} on day {q['day']} "
                        f"and {gbp(p['amount'])} on day {p['day']}")
            seen[p["invoice_id"]] = p
        return "Invoice paid twice"
    if tid == "T5":
        per: dict = {}
        for p in pays:
            if p["po"]:
                per.setdefault(p["po"], []).append(p)
        best = None
        for po, ps in per.items():
            over = sum(p["amount"] for p in ps) - seed.POS[po].limit
            if best is None or over > best[0]:
                best = (over, po, ps)
        _, po, ps = best
        return (f"{gbp(sum(p['amount'] for p in ps))} paid against {po} "
                f"(received × price = {gbp(seed.POS[po].limit)}) via {len(ps)} invoices")
    return f"{len(pays)} payments"


# --------------------------------------------------------------------------- theorems

def _negation(tid: str, sm: SlotModel):
    """The negated theorem, in a form that shares sub-terms with the rule
    expressions (so Z3 can line the sums up). Each form is equivalent to the
    PLAN §6.2 negation, over the bounded model (amounts > 0, auto => active):

    T1  Σ_i [active_i ∧ auto_i]·amt_i > £5,000            (auto => active)
    T2  ∃k auto_k: Σ_{j<k} [auto_j ∧ vend_j = vend_k ∧ day_j = day_k]·amt_j + amt_k > £100
        (=> take k = the last auto payment of the offending vendor-day;
         <= the partial sum is at most that vendor-day's auto total)
    T3  ∃ j: active_j ∧ ∃ i<j: active_i ∧ inv_i = inv_j
    T5  ∃k active_k with a PO: Σ_{j<k} [active_j ∧ po_j = po_k]·amt_j + amt_k > limit(po_k)
        (=> take k = the last active payment against the over-paid PO; <= likewise)
    """
    S = sm.slots
    bounds = _bounds_of(sm.ctx)

    def norm(e):
        return bound_simplify(e, bounds)

    if tid == "T1":
        return norm(z3.Sum([z3.If(z3.And(t.active, t.auto), t.amount, 0) for t in S]) > seed.AUTO_CAP)
    if tid == "T2":
        return z3.Or([norm(z3.And(p.auto, z3.Sum(
            [z3.If(z3.And(h.auto, h.vendor == p.vendor, h.day == p.day), h.amount, 0) for h in S[:k]]
        ) + p.amount > DAILY_CAP)) for k, p in enumerate(S)])
    if tid == "T3":
        return z3.Or([norm(z3.And(p.active, z3.Or([z3.And(h.active, h.invoice == p.invoice) for h in S[:k]])))
                      for k, p in enumerate(S) if k > 0])
    if tid == "T5":
        return z3.Or([norm(z3.And(p.active, p.po != sm.ctx.no_po, z3.Sum(
            [z3.If(z3.And(h.active, h.po == p.po), h.amount, 0) for h in S[:k]]
        ) + p.amount > Z3Ops.lookup(p.po, sm.ctx.po_limit, 0))) for k, p in enumerate(S)])
    raise KeyError(tid)


def _lemmas(tid: str, sm: SlotModel) -> list:
    """Implied facts that help Z3 line T2's auto-only sums up with P7's executed sums.
    Each is valid in the base model (auto => active, amounts > 0), so adding them
    changes nothing logically; it only speeds up the proof."""
    if tid != "T2":
        return []
    bounds, out = _bounds_of(sm.ctx), []
    for k, p in enumerate(sm.slots):
        for h in sm.slots[:k]:
            c = z3.And(h.vendor == p.vendor, h.day == p.day)
            out.append(bound_simplify(
                z3.If(z3.And(h.auto, c), h.amount, 0) <= z3.If(z3.And(h.active, c), h.amount, 0), bounds))
    return out


def _spread(sm: SlotModel, k: int) -> list:
    """Search hint: exactly the first k slots are active, spread evenly over the window."""
    k = min(k, sm.n)
    out = [z3.Implies(t.active, t.day == i * DAYS // k) for i, t in enumerate(sm.slots[:k])]
    return out + ([z3.Not(sm.slots[k].active)] if k < sm.n else [])


def _attack_hints(tid: str, sm: SlotModel) -> list:
    """Search hints for finding an attack faster: no human approvals, and (for T1)
    every payment at the £100 approval threshold. Restricting the search can only
    remove models, so a SAT answer is still a genuine attack on the full model; an
    UNSAT answer here proves nothing and falls through to the full search."""
    hints = [z3.Implies(t.active, t.auto) for t in sm.slots] if tid in ("T1", "T2") else []
    if tid == "T1":
        hints += [z3.Implies(t.active, t.amount == DAILY_CAP) for t in sm.slots]
    return hints


FIRST_MS = 20_000
HINT_MS = 20_000
CLEAN_MS = 5_000


def _prove_slot_theorem(tid: str, sm: SlotModel, timeout_ms: int) -> dict:
    t0 = time.perf_counter()

    def left():
        return max(0, int(timeout_ms - (time.perf_counter() - t0) * 1000))

    neg = _negation(tid, sm)
    full = [neg] + _lemmas(tid, sm)
    hints = _attack_hints(tid, sm)
    r, hinted = z3.unknown, False
    if tid == "T1":  # the hinted searches are fast both ways for T1, so try them first
        fewest = seed.AUTO_CAP // DAILY_CAP + 1          # payments of £100 needed to pass the cap
        for extra in (hints + _spread(sm, fewest), hints):
            r2, m2 = _solve(sm, [neg] + extra, min(HINT_MS, left()))
            if r2 == z3.sat:
                r, m, hinted = r2, m2, True
                break
    if r == z3.unknown:
        r, m = _solve(sm, full, min(FIRST_MS, left()))
    if r == z3.unknown and hints and tid != "T1" and left() > 0:
        r2, m2 = _solve(sm, [neg] + hints, min(HINT_MS, left()))
        if r2 == z3.sat:
            r, m, hinted = r2, m2, True
    if r == z3.unknown and left() > 1000:
        r, m = _solve(sm, full, left())
    res = {"id": tid, "statement": THEOREMS[tid]}
    if r == z3.unsat:
        res["status"] = "proved"
    elif r == z3.sat:
        # Cleaner attack for display (no approvals, whole-pound amounts), only if found quickly.
        tidy = [z3.Implies(t.active, t.auto) for t in sm.slots] if tid in ("T1", "T2") else []
        tidy += [t.amount % 100 == 0 for t in sm.slots]
        tries = [tidy]
        if tid != "T1":  # short attacks: prefer one with few payments
            tries = [tidy + [z3.Not(sm.slots[k].active)] for k in (2, 3, 4) if k < sm.n] + tries
        for extra in ([] if hinted else tries):  # hinted attacks are already tidy
            r3, m3 = _solve(sm, [neg] + extra, CLEAN_MS)
            if r3 == z3.sat:
                m = m3
                break
        pays = _extract(m, sm)
        res["status"] = "attack"
        res["counterexample"] = {"summary": _summary(tid, pays), "payments": pays}
    else:
        res["status"] = "timeout"
    res["seconds"] = round(time.perf_counter() - t0, 2)
    return res


def prove_t6(timeout_ms: int = CHECK_TIMEOUT_MS) -> dict:
    """Escrow conserves money: capture c = A·d/q (rounded down), released = A − c."""
    t0 = time.perf_counter()
    a, d, q = z3.Ints("esc_authorised esc_delivered esc_ordered")
    c = escrow_capture(a, d, q)
    released = a - c
    pre = [a >= 0, a <= MAX_AMOUNT, q >= 1, q <= 10_000, d >= 0, d <= q]
    goal = z3.And(c >= 0, c <= a, c + released == a, z3.Implies(d == 0, c == 0))
    s = z3.Solver()
    s.set("timeout", timeout_ms)
    s.add(pre + [z3.Not(goal)])
    r = s.check()
    res = {"id": "T6", "statement": THEOREMS["T6"]}
    if r == z3.unsat:
        res["status"] = "proved"
    elif r == z3.sat:
        m = s.model()
        A, D, Q = (_ival(m, x) for x in (a, d, q))
        cc = A * D // Q
        res["status"] = "attack"
        res["counterexample"] = {"summary": f"Authorised {gbp(A)}, delivered {D}/{Q}: capture {gbp(cc)}",
                                 "payments": []}
    else:
        res["status"] = "timeout"
    res["seconds"] = round(time.perf_counter() - t0, 2)
    return res


def _history(m_slots: int, p: Txn, ctx: Ctx, cons: list, prefix: str) -> list[Txn]:
    """Arbitrary executed history before p (not required to be reachable: a stronger claim)."""
    hist = []
    for i in range(m_slots):
        h = _slot_vars(prefix, i, ctx, cons)
        cons.append(z3.Implies(h.auto, h.active))
        cons.append(h.day <= p.day)
        hist.append(h)
    return hist


def prove_t7(version: str, m_slots: int = T7_HISTORY, timeout_ms: int = CHECK_TIMEOUT_MS) -> dict:
    """No over-blocking: a payment meeting the business preconditions (stated here as
    the spec, independently of the rules) is always allowed or escrowed."""
    t0 = time.perf_counter()
    pol_mod = _policy_mod()
    pol = pol_mod.get_policy(version)
    ctx = Ctx.symbolic()
    cons: list = []
    p = _slot_vars("t7p_", 0, ctx, cons)
    hist = _history(m_slots, p, ctx, cons, "t7h_")
    dec = pol_mod.decide(pol, p, hist, ctx, Z3Ops)

    def hsum(cond):
        return z3.Sum([z3.If(z3.And(h.active, cond(h)), h.amount, 0) for h in hist])

    pre = [
        p.po != ctx.no_po,                                                  # has a PO ...
        Z3Ops.lookup(p.po, ctx.po_vendor, ctx.no_vendor) == p.vendor,       # ... for this vendor
        p.amount <= DAILY_CAP,                                              # ≤ £100
        z3.And([z3.Not(z3.And(h.active, h.invoice == p.invoice)) for h in hist]),  # new invoice id
        hsum(lambda h: h.po == p.po) + p.amount <= Z3Ops.lookup(p.po, ctx.po_limit, 0),  # within PO limit
        hsum(lambda h: z3.And(h.vendor == p.vendor, h.day == p.day)) + p.amount <= DAILY_CAP,
        hsum(lambda h: z3.And(h.auto, h.day > p.day - DAYS)) + p.amount <= seed.AUTO_CAP,
    ]
    res = {"id": "T7", "statement": THEOREMS["T7"]}
    vac = z3.Solver()
    vac.set("timeout", timeout_ms)
    vac.add(cons + pre)
    if vac.check() != z3.sat:  # the preconditions must be satisfiable, or T7 is vacuous
        res.update(status="error", error="preconditions unsatisfiable (T7 would hold vacuously)",
                   seconds=round(time.perf_counter() - t0, 2))
        return res
    s = z3.SolverFor("QF_LIA")
    s.set("timeout", timeout_ms)
    s.add(cons + pre + [dec > ESCROW])
    r = s.check()
    if r == z3.unsat:
        res["status"] = "proved"
    elif r == z3.sat:
        m = s.model()
        pays = []
        for h in hist:
            if _bval(m, h.active):
                po = _ival(m, h.po)
                pays.append({"day": _ival(m, h.day), "vendor": ctx.vendor_ids[_ival(m, h.vendor)],
                             "po": None if po == -1 else ctx.po_ids[po], "amount": _ival(m, h.amount),
                             "invoice_id": _ival(m, h.invoice), "auto": _bval(m, h.auto)})
        po = _ival(m, p.po)
        new = {"day": _ival(m, p.day), "vendor": ctx.vendor_ids[_ival(m, p.vendor)],
               "po": ctx.po_ids[po], "amount": _ival(m, p.amount), "invoice_id": _ival(m, p.invoice),
               "auto": False, "decision": SEV_NAME[_ival(m, dec)]}
        res["status"] = "attack"
        res["counterexample"] = {
            "summary": (f"Valid {gbp(new['amount'])} invoice to {new['vendor']} on {new['po']} "
                        f"is {new['decision']}ed"),
            "payments": pays + [new]}
    else:
        res["status"] = "timeout"
    res["seconds"] = round(time.perf_counter() - t0, 2)
    return res


def prove_t8(version: str, parent: str = "v4", m_slots: int = T7_HISTORY,
             timeout_ms: int = CHECK_TIMEOUT_MS) -> dict:
    """Refinement: one payment + arbitrary history; the policy under test allows it
    (allow/escrow) while the parent policy would not."""
    t0 = time.perf_counter()
    pol_mod = _policy_mod()
    child, par = pol_mod.get_policy(version), pol_mod.get_policy(parent)
    ctx = Ctx.symbolic()
    cons: list = []
    p = _slot_vars("t8p_", 0, ctx, cons)
    hist = _history(m_slots, p, ctx, cons, "t8h_")
    dc = pol_mod.decide(child, p, hist, ctx, Z3Ops)
    dp = pol_mod.decide(par, p, hist, ctx, Z3Ops)
    s = z3.SolverFor("QF_LIA")
    s.set("timeout", timeout_ms)
    s.add(cons + [dc <= ESCROW, dp > ESCROW])
    r = s.check()
    res = {"id": "T8", "statement": THEOREMS["T8"].replace("v4", parent)}
    if r == z3.unsat:
        res["status"] = "proved"
    elif r == z3.sat:
        m = s.model()
        po = _ival(m, p.po)
        new = {"day": _ival(m, p.day), "vendor": ctx.vendor_ids[_ival(m, p.vendor)],
               "po": None if po == -1 else ctx.po_ids[po], "amount": _ival(m, p.amount),
               "invoice_id": _ival(m, p.invoice), "auto": True,
               "decision": SEV_NAME[_ival(m, dc)]}
        pays = []
        for h in hist:
            if _bval(m, h.active):
                hpo = _ival(m, h.po)
                pays.append({"day": _ival(m, h.day), "vendor": ctx.vendor_ids[_ival(m, h.vendor)],
                             "po": None if hpo == -1 else ctx.po_ids[hpo], "amount": _ival(m, h.amount),
                             "invoice_id": _ival(m, h.invoice), "auto": _bval(m, h.auto)})
        res["status"] = "attack"
        res["counterexample"] = {
            "summary": (f"{version} {new['decision']}s a {gbp(new['amount'])} payment to {new['vendor']} "
                        f"that {parent} would {SEV_NAME[_ival(m, dp)]}"),
            "payments": pays + [new]}
    else:
        res["status"] = "timeout"
    res["seconds"] = round(time.perf_counter() - t0, 2)
    return res


def _unsat(sm: SlotModel, extra: list, timeout_ms: int) -> bool:
    return _solve(sm, extra, timeout_ms)[0] == z3.unsat


def _valid(facts: list, goal, timeout_ms: int = 5000) -> bool:
    """facts => goal, checked by Z3 (used for the small glue steps of the worst case)."""
    s = z3.Solver()
    s.set("timeout", timeout_ms)
    s.add(facts + [z3.Not(goal)])
    return s.check() == z3.unsat


def worst_case(sm: SlotModel, timeout_ms: int = OPT_TIMEOUT_MS) -> dict:
    """Maximum unapproved (auto) spend in the window under the policy.

    z3.Optimize alone rarely finishes on this model, so this works in two halves,
    each checked by Z3 against the full slot model:
      upper bound U = the smallest of
        * £5,000         if T1's negation is UNSAT;
        * Σ PO limits    if every PO's executed total is within its limit (T5) and
                         every auto payment has a PO (both checked here);
        * N × £100       if no single auto payment exceeds £100;
      lower bound: a run of the policy that reaches U (hinted search: no approvals).
    If both meet, the value is exact ("optimal"). Otherwise Optimize runs for the
    remaining time and the result is "timeout" with the best value found and U."""
    t0 = time.perf_counter()
    S, ctx = sm.slots, sm.ctx
    bounds = _bounds_of(ctx)
    npo = len(ctx.po_ids)
    total = bound_simplify(z3.Sum([z3.If(z3.And(t.active, t.auto), t.amount, 0) for t in S]), bounds)
    step = max(2000, timeout_ms // 3)
    ubs = {}
    if _unsat(sm, [_negation("T1", sm)], step):
        ubs["T1 (≤ £5,000)"] = seed.AUTO_CAP
    if (_unsat(sm, [_negation("T5", sm)], step)
            and _unsat(sm, [z3.Or([z3.And(t.auto, t.po == ctx.no_po) for t in S])], step)):
        per_po = [z3.Sum([z3.If(z3.And(t.active, t.po == c), t.amount, 0) for t in S]) <= ctx.po_limit[c]
                  for c in range(npo)]                                   # T5 at each PO
        has_po = [z3.Implies(t.auto, t.po != ctx.no_po) for t in S]      # just proved
        dom = [z3.And(t.po >= ctx.no_po, t.po <= npo - 1, t.amount >= 1) for t in S]
        # per payment: its auto amount is counted under exactly one PO (checked per slot)
        split = [z3.If(z3.And(t.active, t.auto), t.amount, 0)
                 <= z3.Sum([z3.If(z3.And(t.active, t.po == c), t.amount, 0) for c in range(npo)])
                 for t in S]
        lim = sum(ctx.po_limit.values())
        if (all(_valid([h, d], g) for h, d, g in zip(has_po, dom, split))
                and _valid(per_po + split, total <= lim)):
            ubs["Σ PO limits (T5)"] = lim
    if _unsat(sm, [z3.Or([z3.And(t.auto, t.amount > DAILY_CAP) for t in S])], step):
        ubs[f"{sm.n} payments × £100"] = sm.n * DAILY_CAP
    out = {"status": "timeout", "value": None, "seconds": None, "upper_bound": None, "bound_by": None}
    if ubs:
        by, ub = min(ubs.items(), key=lambda kv: kv[1])
        out.update(upper_bound=ub, bound_by=by)
        hints = [z3.Implies(t.active, t.auto) for t in S]
        flat = [z3.Implies(t.active, t.amount == DAILY_CAP) for t in S]
        spread = _spread(sm, -(-ub // DAILY_CAP)) if ub % DAILY_CAP == 0 else []
        for extra, share in ((hints + flat + spread, 0.3), (hints + flat, 0.5), (hints, 1.0)):
            left = int(timeout_ms - (time.perf_counter() - t0) * 1000)
            r, m = _solve(sm, [total >= ub] + extra, max(int(left * share), 2000))
            if r == z3.sat:
                out.update(status="optimal", value=_ival(m, total))
                out["witness"] = _extract(m, sm)
                break
    if out["status"] != "optimal":
        left = int(timeout_ms - (time.perf_counter() - t0) * 1000)
        o = z3.Optimize()
        o.set("timeout", max(left, 2000))
        o.add(sm.constraints)
        h = o.maximize(total)
        if o.check() == z3.sat:
            out.update(status="optimal", value=_ival(o.model(), total))
        else:
            try:  # best value found so far (a lower bound)
                lb = h.lower()
                out["value"] = lb.as_long() if z3.is_int_value(lb) else None
            except Exception:
                pass
    out["seconds"] = round(time.perf_counter() - t0, 2)
    out["bounded_by_n"] = out.get("bound_by", "") is not None and "payments" in (out.get("bound_by") or "")
    return out


# --------------------------------------------------------------------------- entry point

def _safe(fn, tid, *args, **kw) -> dict:
    t0 = time.perf_counter()
    try:
        return fn(*args, **kw)
    except Exception as e:  # never take the app down
        return {"id": tid, "statement": THEOREMS.get(tid, tid), "status": "error",
                "error": f"{type(e).__name__}: {e}", "seconds": round(time.perf_counter() - t0, 2)}


def prove_all(version: str, n: int = DEFAULT_N, include=None, worst: bool = True,
              timeout_ms: int = CHECK_TIMEOUT_MS) -> dict:
    """Run every theorem for one policy version; the /api/prove shape (IMPLEMENTATION §3)."""
    if n < 51:
        raise ValueError("n must be >= 51 so that n x £100 > £5,000 (otherwise T1 holds vacuously)")
    include = include or (P0 + P1)
    pol = _policy_mod().get_policy(version)
    out = {"version": version, "hash": pol.hash, "n": n, "running": False,
           "bound": f"proved for up to {n} payments / 30 days, against the seed PO table",
           "theorems": [], "worst_case": {"status": "pending", "value": None, "seconds": None}}
    t0 = time.perf_counter()
    try:
        sm = build_slots(version, n)
        build_err = None
    except Exception as e:
        sm, build_err = None, f"{type(e).__name__}: {e}"
    out["build_seconds"] = round(time.perf_counter() - t0, 2)
    for tid in include:
        if tid in P0:
            if sm is None:
                out["theorems"].append({"id": tid, "statement": THEOREMS[tid], "status": "error",
                                        "error": build_err, "seconds": 0})
            else:
                out["theorems"].append(_safe(_prove_slot_theorem, tid, tid, sm, timeout_ms))
        elif tid == "T6":
            out["theorems"].append(_safe(prove_t6, tid, timeout_ms))
        elif tid == "T7":
            out["theorems"].append(_safe(prove_t7, tid, version, timeout_ms=timeout_ms))
        elif tid == "T8":
            out["theorems"].append(_safe(prove_t8, tid, version, timeout_ms=timeout_ms))
    if worst and sm is not None:
        try:
            out["worst_case"] = worst_case(sm)
        except Exception as e:
            out["worst_case"] = {"status": "error", "value": None, "seconds": None,
                                 "error": f"{type(e).__name__}: {e}"}
    return out


def _table(results: list[dict]) -> str:
    ids = [t["id"] for t in results[0]["theorems"]]
    mark = {"proved": "✓", "attack": "✗", "timeout": "⏱", "error": "!", "pending": "…"}
    lines = ["ver   " + "  ".join(f"{i:>10}" for i in ids) + "  worst case"]
    for r in results:
        cells = [f"{mark[t['status']]} {t['seconds']:>6.1f}s" for t in r["theorems"]]
        w = r["worst_case"]
        wv = gbp(w["value"]) if w.get("value") is not None else "-"
        lines.append(f"{r['version']:<5} " + "  ".join(f"{c:>10}" for c in cells)
                     + f"  {wv} ({w['status']}, {w.get('seconds')}s)")
    return "\n".join(lines)


if __name__ == "__main__":
    import sys
    n = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_N
    results = []
    for v in ["v1", "v2", "v3", "v4"]:
        r = prove_all(v, n)
        results.append(r)
        print(f"\n{v} (hash {r['hash']}, N = {n}, build {r['build_seconds']}s)", flush=True)
        for t in r["theorems"]:
            line = f"  {t['id']} {t['status']:<8} {t['seconds']:>6.2f}s  {t['statement']}"
            if t.get("counterexample"):
                line += f"\n      attack: {t['counterexample']['summary']}"
            if t.get("error"):
                line += f"\n      error: {t['error']}"
            print(line, flush=True)
        print(f"  worst case: { {k: v for k, v in r['worst_case'].items() if k != 'witness'} }", flush=True)
    print("\n" + _table(results))
