"""Policy versions v1-v4 (PLAN §5.3) and the decision function shared by gate and prover."""
import hashlib
import inspect
from dataclasses import dataclass

from .rules import RULES, Rule

SEV = {"allow": 0, "escrow": 1, "hold": 2, "block": 3}
SEV_NAME = {v: k for k, v in SEV.items()}


@dataclass(frozen=True)
class Policy:
    version: str
    note: str
    rule_ids: list
    hash: str


def _hash(rule_ids) -> str:
    h = hashlib.sha256()
    for rid in rule_ids:
        h.update(rid.encode())
        h.update(inspect.getsource(RULES[rid].fires).encode())
    return h.hexdigest()[:8]


_VERSIONS = [
    ("v1", "v1: per-payment limits only (P4, P5, P6, P9, naive P10, P11)",
     ["P4", "P5", "P6", "P9", "P10_naive", "P11", "P12"]),
    ("v2", "v2: adds P7 (over £100 to one vendor in one day needs approval)",
     ["P4", "P5", "P6", "P7", "P9", "P10_naive", "P11", "P12"]),
    ("v3", "v3: adds P8 (unapproved spend capped at £5,000 per 30 days)",
     ["P4", "P5", "P6", "P7", "P8", "P9", "P10_naive", "P11", "P12"]),
    ("v4", "v4: P10 counts everything already paid against the PO (final)",
     ["P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11", "P12"]),
]

POLICIES: dict[str, Policy] = {v: Policy(v, note, ids, _hash(ids)) for v, note, ids in _VERSIONS}
DEFAULT_VERSION = "v4"


def get_policy(version: str) -> Policy:
    if isinstance(version, Policy):
        return version
    return POLICIES[version]


def rules_of(policy) -> list[Rule]:
    """Rules the gate evaluates, in display order (excludes P12, which is checked at approval)."""
    policy = get_policy(policy)
    return [RULES[r] for r in policy.rule_ids if RULES[r].decision != "approval"]


def fired(policy, p, hist, ctx, ops) -> dict:
    return {r.id: r.fires(p, hist, ctx, ops) for r in rules_of(policy)}


def decide(policy, p, hist, ctx, ops):
    """Max severity over the fired rules (0 = allow if none fire). Concrete int or Z3 IntExpr."""
    sev = 0
    for r in rules_of(policy):
        sev = ops.Max(sev, ops.If(r.fires(p, hist, ctx, ops), SEV[r.decision], 0))
    return sev
