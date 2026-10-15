"""Replay the 8 demo fixtures (PLAN §11) through the gate under policy v4."""
from app import gate, rules

FIXTURES = [
    # (invoice, vendor, amount, po, day, decision, deciding_rules)
    ("INV-001", "cloudco", 80_00, "PO-1", 1, "allow", []),
    ("INV-002", "cloudco", 80_00, "PO-1", 1, "hold", ["P7"]),
    ("INV-001", "cloudco", 80_00, "PO-1", 1, "block", ["P4"]),
    # P7 necessarily fires with P6 (a single £320 is already > £100 for the vendor that day)
    ("INV-003", "printshop", 320_00, "PO-2", 2, "hold", ["P6", "P7"]),
    ("INV-004", "labelbot", 90_00, "PO-3", 2, "escrow", ["P11"]),
    ("INV-005", "quickfix", 9000_00, "PO-5", 3, "block", ["P5", "P10"]),
    ("INV-006", "printshop", 90_00, "PO-4", 3, "block", ["P10"]),
    ("INV-007", "cloudco", 40_00, None, 4, "hold", ["P9"]),
]

STATUS = {"allow": "paid", "escrow": "escrow_authorised", "hold": "held", "block": "blocked"}


def _fire(payments, inv, vendor, amount, po, day):
    proposal = {"invoice_id": inv, "vendor_id": vendor, "amount": amount, "po_id": po,
                "reasoning": "structured fields (no LLM)", "source": "fallback"}
    res = gate.evaluate(proposal, payments, day, "v4")
    pay = {"id": f"pay_{len(payments) + 1:04d}", "day": day, "proposal": proposal, "amount": amount,
           "decision": res["decision"], "deciding_rules": res["deciding_rules"],
           "execute_as": res["execute_as"], "status": STATUS[res["decision"]],
           "auto": res["decision"] in ("allow", "escrow"), "captured_amount": None}
    payments.append(pay)
    return res, pay


def _approve(pay, approver):
    check = rules.approval_check(pay["proposal"]["po_id"], approver)
    if check["ok"]:
        pay["status"] = "escrow_authorised" if pay["execute_as"] == "escrow" else "paid"
        pay["auto"] = False
    return check


def test_demo_fixtures_v4():
    payments = []
    results = []
    for inv, vendor, amount, po, day, decision, deciding in FIXTURES:
        res, pay = _fire(payments, inv, vendor, amount, po, day)
        assert res["decision"] == decision, (inv, res["verdict"])
        assert res["deciding_rules"] == deciding, (inv, res["verdict"])
        assert res["policy_version"] == "v4" and len(res["policy_hash"]) == 8
        assert [t["rule_id"] for t in res["trace"]] == ["P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11"]
        results.append((res, pay))

    verdicts = [r["verdict"] for r, _ in results]
    assert verdicts[0] == "Paid: passed all 8 rules."
    assert verdicts[1].startswith("Held by P7: CloudCo Hosting already received £80 today")
    assert "£80 + £80 = £160 > £100" in verdicts[1]
    assert verdicts[2].startswith("Blocked by P4: INV-001 already paid")
    assert verdicts[4].startswith("Escrow by P11:")
    assert verdicts[5].startswith("Blocked by P5 and P10: £9,000 > £500")
    assert "£0 + £90 = £90 > £60" in verdicts[6]
    assert verdicts[7] == "Held by P9: no purchase order on the invoice."
    assert results[4][0]["execute_as"] == "escrow"

    p7 = next(t for t in results[1][0]["trace"] if t["rule_id"] == "P7")
    assert p7["evidence"] == ["history: INV-001 £80 on day 1"]
    p10 = next(t for t in results[6][0]["trace"] if t["rule_id"] == "P10")
    assert "PO-4: PrintShop Ltd, received 4 × £15 = £60" in p10["evidence"]
    p5 = next(t for t in results[0][0]["trace"] if t["rule_id"] == "P5")
    assert p5["detail"] == "£80 ≤ £500" and not p5["fired"]

    # Hand actions after the invoices arrive.
    # Fixture 2: bob requested PO-1, so P12 refuses him; alice approves.
    assert not _approve(results[1][1], "bob")["ok"]
    assert _approve(results[1][1], "alice")["ok"]                 # fixture 2 -> paid
    refused = _approve(results[3][1], "bob")                      # fixture 4: bob requested PO-2
    assert not refused["ok"] and refused["reason"].startswith("P12: bob requested PO-2")
    assert results[3][1]["status"] == "held"
    assert _approve(results[3][1], "alice")["ok"]                 # fixture 4 -> paid
    assert results[3][1]["status"] == "paid" and results[3][1]["auto"] is False

    esc = results[4][1]                                           # fixture 5: deliver 70/100
    esc["status"], esc["captured_amount"] = "escrow_captured", 90_00 * 70 // 100
    assert esc["captured_amount"] == 63_00

    # Effects on the history: auto spend counts INV-001 and the escrow (captured £63), not approvals.
    res, _ = _fire(payments, "INV-008", "cloudco", 10_00, "PO-1", 5)
    assert res["decision"] == "allow"
    assert res["auto_spend_before"] == 80_00 + 63_00
    # PO-1 now has £160 paid (INV-001 auto + INV-002 approved): £160 + £50 > £200
    res, _ = _fire(payments, "INV-009", "cloudco", 50_00, "PO-1", 6)
    assert res["decision"] == "block" and res["deciding_rules"] == ["P10"]
    assert "£170 + £50 = £220 > £200" in res["verdict"]
    # The escrow counts its captured amount against PO-3: £63 + £27 = £90, not over
    res, _ = _fire(payments, "INV-010", "labelbot", 27_00, "PO-3", 7)
    assert res["decision"] == "allow", res["verdict"]


def test_duplicate_of_approved_payment_still_blocked():
    """If alice approves INV-002 before INV-001 is resent, P4 still blocks (P10 now fires too)."""
    payments = []
    _fire(payments, "INV-001", "cloudco", 80_00, "PO-1", 1)
    _, held = _fire(payments, "INV-002", "cloudco", 80_00, "PO-1", 1)
    assert _approve(held, "alice")["ok"]
    res, _ = _fire(payments, "INV-001", "cloudco", 80_00, "PO-1", 1)
    assert res["decision"] == "block" and "P4" in res["deciding_rules"]


def test_duplicate_of_held_payment_blocked():
    payments = []
    _fire(payments, "INV-001", "cloudco", 80_00, "PO-1", 1)
    _fire(payments, "INV-002", "cloudco", 80_00, "PO-1", 1)       # held by P7
    res, _ = _fire(payments, "INV-002", "cloudco", 10_00, "PO-1", 2)
    assert res["decision"] == "block" and res["deciding_rules"] == ["P4"]
    assert "held awaiting approval" in res["verdict"]


def test_fmt_gbp():
    assert [gate.fmt_gbp(x) for x in (8000, 90, 500000, 6350, 0)] == ["£80", "£0.90", "£5,000", "£63.50", "£0"]
