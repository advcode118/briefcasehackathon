"""Prover results across policy versions, plus a replay of every attack through the
concrete gate (evidence that attacks are real runs of the enforced policy, not
artefacts of the prover's encoding).

Runs in ~1.5-2 min. Set PROVER_SLOW=1 to also run the worst-case optimisation.
"""
import os

import pytest

from app import gate, prover, seed

N = prover.DEFAULT_N

EXPECTED = {
    "v1": {"T1": "attack", "T2": "attack", "T3": "proved", "T5": "attack"},
    "v2": {"T1": "attack", "T2": "proved", "T3": "proved", "T5": "attack"},
    "v3": {"T1": "proved", "T2": "proved", "T3": "proved", "T5": "attack"},
    "v4": {"T1": "proved", "T2": "proved", "T3": "proved", "T5": "proved"},
}

_CACHE: dict = {}


def _results(version: str) -> dict:
    """One slot model per version, shared by its four P0 theorems."""
    if version not in _CACHE:
        sm = prover.build_slots(version, N)
        _CACHE[version] = {tid: prover._prove_slot_theorem(tid, sm, prover.CHECK_TIMEOUT_MS)
                           for tid in prover.P0}
    return _CACHE[version]


@pytest.mark.parametrize("version", list(EXPECTED))
def test_p0_statuses(version):
    res = _results(version)
    got = {tid: r["status"] for tid, r in res.items()}
    assert got == EXPECTED[version]


def _replay(version: str, payments: list[dict]) -> list[dict]:
    """Feed the attack's payments, in order, to the concrete gate. Auto slots are
    executed with auto=True; active non-auto slots are executed as human-approved."""
    executed = []
    for i, p in enumerate(payments):
        proposal = {"invoice_id": f"INV-{p['invoice_id']}", "vendor_id": p["vendor"],
                    "amount": p["amount"], "po_id": p["po"]}
        out = gate.evaluate(proposal, executed, p["day"], version)
        assert out["decision"] != "block", f"slot {i} {p} blocked by {out['deciding_rules']}"
        if p["auto"]:
            assert out["decision"] in ("allow", "escrow"), f"slot {i} {p} was {out['decision']}"
        executed.append({"status": "paid", "auto": p["auto"], "day": p["day"],
                         "amount": p["amount"], "proposal": proposal})
    return executed


@pytest.mark.parametrize("version", list(EXPECTED))
def test_attacks_replay_through_gate(version):
    for tid, r in _results(version).items():
        if r["status"] != "attack":
            continue
        pays = r["counterexample"]["payments"]
        _replay(version, pays)
        auto = [p for p in pays if p["auto"]]
        if tid == "T1":
            assert sum(p["amount"] for p in auto) > seed.AUTO_CAP
        elif tid == "T2":
            per: dict = {}
            for p in auto:
                per[(p["vendor"], p["day"])] = per.get((p["vendor"], p["day"]), 0) + p["amount"]
            assert max(per.values()) > 100_00
        elif tid == "T3":
            ids = [p["invoice_id"] for p in pays]
            assert len(ids) != len(set(ids))
        elif tid == "T5":
            per = {}
            for p in pays:
                if p["po"]:
                    per[p["po"]] = per.get(p["po"], 0) + p["amount"]
            assert any(total > seed.POS[po].limit for po, total in per.items())


@pytest.mark.parametrize("version", ["v1", "v4"])
def test_t6_t7(version):
    assert prover.prove_t6()["status"] == "proved"
    assert prover.prove_t7(version)["status"] == "proved"


def test_prove_all_shape():
    r = prover.prove_all("v4", N, include=["T6"], worst=False)
    assert r["version"] == "v4" and r["n"] == N and r["running"] is False
    assert [t["id"] for t in r["theorems"]] == ["T6"]
    t = r["theorems"][0]
    assert set(t) >= {"id", "statement", "status", "seconds"}
    with pytest.raises(ValueError):
        prover.prove_all("v4", 50)


@pytest.mark.skipif(not os.environ.get("PROVER_SLOW"), reason="set PROVER_SLOW=1 (worst-case optimisation, ~20 s+)")
def test_worst_case_v4_within_cap():
    w = prover.worst_case(prover.build_slots("v4", N))
    if w["status"] == "optimal":
        assert w["value"] <= seed.AUTO_CAP
    else:
        assert w["status"] == "timeout"
