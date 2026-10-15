"""The 8 demo fixtures (PLAN §11) through the real HTTP API, offline (no Stripe, no LLM)."""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app

FIXTURES = sorted((Path(__file__).resolve().parent.parent / "fixtures" / "invoices").glob("*.json"))

# (decision, rules that must be among the deciding rules, status)
EXPECTED = [
    ("allow", [], "paid"),
    ("hold", ["P7"], "held"),
    ("block", ["P4"], "blocked"),
    ("hold", ["P6"], "held"),
    ("escrow", ["P11"], "escrow_authorised"),
    ("block", ["P5", "P10"], "blocked"),
    ("block", ["P10"], "blocked"),
    ("hold", ["P9"], "held"),
]


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("PROVEN_STATE_PATH", str(tmp_path / "state.json"))
    monkeypatch.setenv("PROVEN_NO_PROVER", "1")
    with TestClient(app) as c:
        assert c.post("/api/policy/version", json={"version": "v4"}).status_code == 200
        s = c.post("/api/reset").json()
        assert s["stripe_mode"] == "offline" and s["agent_mode"] == "fallback"
        yield c


def fire_all(client) -> list[dict]:
    out = []
    for f in FIXTURES:
        r = client.post("/webhook/invoice", json=json.loads(f.read_text()))
        assert r.status_code == 200, r.text
        out.append(r.json())
    return out


def test_fixture_files():
    assert len(FIXTURES) == 8


def test_fixture_decisions(client):
    pays = fire_all(client)
    for i, (pay, (decision, rules, status)) in enumerate(zip(pays, EXPECTED), start=1):
        assert pay["decision"] == decision, (i, pay["verdict"])
        assert set(rules) <= set(pay["deciding_rules"]), (i, pay["deciding_rules"])
        assert pay["status"] == status, i
        assert pay["proposal"]["source"] == ("compromised" if pay["invoice"].get("simulate") else "fallback")
        assert pay["policy_version"] == "v4"
    assert pays[0]["stripe_pi_id"].startswith("pi_offline_") and pays[0]["auto"] is True
    assert pays[2]["stripe_pi_id"] is None
    feed = client.get("/api/payments").json()
    assert [p["id"] for p in feed] == [p["id"] for p in reversed(pays)]


def test_demo_actions(client):
    pays = fire_all(client)
    p2, p4, p5 = pays[1]["id"], pays[3]["id"], pays[4]["id"]

    r = client.post(f"/api/payments/{p2}/approve", json={"approver": "alice"}).json()
    assert r["status"] == "paid" and r["auto"] is False and r["approvals"][-1]["ok"] is True
    assert "approved by alice" in r["verdict"]

    r = client.post(f"/api/payments/{p4}/approve", json={"approver": "bob"}).json()
    assert r["status"] == "held"
    assert r["approvals"][-1]["ok"] is False and "P12" in r["approvals"][-1]["reason"]
    r = client.post(f"/api/payments/{p4}/approve", json={"approver": "alice"}).json()
    assert r["status"] == "paid" and len(r["approvals"]) == 2

    r = client.post("/webhook/delivery", json={"payment_id": p5, "delivered_qty": 70}).json()
    assert r["status"] == "escrow_captured" and r["captured_amount"] == 6300
    assert r["delivered_qty"] == 70 and r["ordered_qty"] == 100
    assert "70/100 delivered, £63 captured, £27 released" in r["verdict"]

    s = client.get("/api/summary").json()
    assert s["total_paid"] == 8000 + 8000 + 32000 + 6300
    assert s["auto_spend_window"] == 8000 + 6300
    assert s["held"] == 1 and s["blocked"] == 3


def test_reject_and_cancel(client):
    pays = fire_all(client)
    r = client.post(f"/api/payments/{pays[7]['id']}/reject", json={"approver": "bob"}).json()
    assert r["status"] == "rejected"
    r = client.post("/webhook/delivery", json={"payment_id": pays[4]["id"], "delivered_qty": 0}).json()
    assert r["status"] == "escrow_cancelled" and r["captured_amount"] == 0


def test_policy_and_prove_shapes(client):
    pol = client.get("/api/policy").json()
    assert pol["version"] == "v4" and len(pol["hash"]) == 8
    ids = {r["id"]: r["active"] for r in pol["rules"]}
    assert ids["P10"] and not ids["P10_naive"] and ids["P12"]
    pol = client.post("/api/policy/version", json={"version": "v1"}).json()
    assert pol["version"] == "v1"
    ids = {r["id"]: r["active"] for r in pol["rules"]}
    assert ids["P10_naive"] and not ids["P7"]
    pr = client.get("/api/prove?version=v1").json()
    assert pr["version"] == "v1" and {t["id"] for t in pr["theorems"]} >= {"T1", "T2", "T3", "T5"}
    client.post("/api/policy/version", json={"version": "v4"})


def test_day_advance(client):
    assert client.post("/api/day/advance").json()["day"] == 2
