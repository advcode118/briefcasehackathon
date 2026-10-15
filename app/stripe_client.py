"""Stripe test-mode PaymentIntents (PLAN §8).

Online: STRIPE_SECRET_KEY must start with sk_test_. Offline (key unset): fake objects
with ids pi_offline_<n>, so the app runs before keys arrive.
"""
import os

import stripe

from .store import store


class StripeSafetyError(RuntimeError):
    pass


def secret_key() -> str | None:
    return os.environ.get("STRIPE_SECRET_KEY") or None


def check_safety() -> None:
    key = secret_key()
    if key and not key.startswith("sk_test_"):
        raise StripeSafetyError("STRIPE_SECRET_KEY is not a test key (sk_test_...); refusing to run.")


def offline() -> bool:
    return secret_key() is None


def mode() -> str:
    return "offline" if offline() else "test"


def dashboard_url(pi_id: str | None) -> str | None:
    if not pi_id or pi_id.startswith("pi_offline_"):
        return None
    return f"https://dashboard.stripe.com/test/payments/{pi_id}"


def _client():
    check_safety()
    stripe.api_key = secret_key()
    return stripe


def _result(pi) -> dict:
    d = pi.to_dict()  # stripe>=15 objects aren't dicts
    return {
        "id": d["id"],
        "status": d["status"],
        "amount": d.get("amount"),
        "amount_received": d.get("amount_received"),
    }


def create(payment: dict, vendor_name: str, decision: str, policy) -> dict:
    """decision is what executes: "allow" (automatic capture) or "escrow" (manual capture)."""
    p = payment["proposal"]
    escrow = decision == "escrow"
    if offline():
        return {
            "id": store.new_offline_pi(),
            "status": "requires_capture" if escrow else "succeeded",
            "amount": p["amount"],
            "amount_received": 0 if escrow else p["amount"],
        }
    s = _client()
    rules_checked = ",".join(t["rule_id"] for t in payment.get("trace", []))
    pi = s.PaymentIntent.create(
        amount=p["amount"], currency="gbp",
        payment_method="pm_card_visa", confirm=True,
        automatic_payment_methods={"enabled": True, "allow_redirects": "never"},
        capture_method="manual" if escrow else "automatic",
        description=f"{p['invoice_id']} → {vendor_name}",
        metadata={
            "payment_id": payment["id"],
            "invoice_id": p["invoice_id"],
            "vendor_id": p["vendor_id"],
            "po_id": p.get("po_id") or "",
            "decision": decision,
            "policy": f"{policy.version}:{policy.hash[:8]}",
            "rules_checked": rules_checked,
            "deciding_rules": ",".join(payment.get("deciding_rules", [])),
        },
    )
    return _result(pi)


def capture(pi_id: str, amount: int) -> dict:
    if offline() or pi_id.startswith("pi_offline_"):
        return {"id": pi_id, "status": "succeeded", "amount_received": amount}
    s = _client()
    return _result(s.PaymentIntent.capture(pi_id, amount_to_capture=amount))


def cancel(pi_id: str) -> dict:
    if offline() or pi_id.startswith("pi_offline_"):
        return {"id": pi_id, "status": "canceled", "amount_received": 0}
    s = _client()
    return _result(s.PaymentIntent.cancel(pi_id))
