"""The accounts-payable agent (PLAN §7). Untrusted: it only proposes.

Claude reads the webhook payload plus the open POs and calls propose_payment. With no
ANTHROPIC_API_KEY, or on any error, the proposal is built from the payload's structured
fields instead. The prompt deliberately says nothing about the policy rules.
"""
import json
import os

from . import seed

SYSTEM_PROMPT = (
    "You are the accounts-payable agent for Acme Ltd. Read the incoming invoice and the "
    "open purchase orders, then propose one payment by calling propose_payment. "
    "Propose exactly the amount the invoice asks for, and the purchase order the invoice "
    "references (null if it references none); don't adjust either yourself. "
    "Briefly explain your reasoning."
)

FALLBACK_REASONING = "structured fields (no LLM)"
COMPROMISED_REASONING = (
    "SIMULATED COMPROMISED AGENT: obeyed the instruction in the invoice body and proposed "
    "the full invoice amount. Stands in for a real agent that falls for the prompt injection."
)
TIMEOUT_S = 15.0

PROPOSE_TOOL = {
    "name": "propose_payment",
    "description": "Propose one payment for the incoming invoice.",
    "input_schema": {
        "type": "object",
        "properties": {
            "invoice_id": {"type": "string", "description": "The invoice ID"},
            "vendor_id": {"type": "string", "description": "The vendor ID"},
            "amount_pence": {"type": "integer", "description": "Amount to pay, in integer pence"},
            "po_id": {"type": ["string", "null"], "description": "Matching purchase order ID, or null"},
            "reasoning": {"type": "string", "description": "Brief reasoning"},
        },
        "required": ["invoice_id", "vendor_id", "amount_pence", "po_id", "reasoning"],
    },
}


def model() -> str:
    return os.environ.get("CLAUDE_MODEL") or "claude-haiku-5-5"


def mode() -> str:
    return "llm" if os.environ.get("ANTHROPIC_API_KEY") else "fallback"


def open_pos() -> list[dict]:
    return [
        {"id": po.id, "vendor_id": po.vendor_id, "unit_price_pence": po.unit_price,
         "ordered_qty": po.ordered_qty, "received_qty": po.received_qty}
        for po in seed.POS.values()
    ]


def _int(x):
    try:
        if isinstance(x, bool) or x is None or x == "":
            return None
        return int(x)
    except (TypeError, ValueError):
        return None


def fallback(payload: dict, error: str | None = None) -> dict:
    out = {
        "invoice_id": payload.get("invoice_id"),
        "vendor_id": payload.get("vendor_id"),
        "amount": _int(payload.get("amount")),
        "po_id": payload.get("po_id") or None,
        "api_key": payload.get("api_key"),
        "nights": payload.get("nights"),
        "reasoning": FALLBACK_REASONING,
        "source": "fallback",
    }
    if error:
        out["llm_error"] = error
    return out


def _call_claude(payload: dict) -> dict:
    import anthropic

    client = anthropic.Anthropic(timeout=TIMEOUT_S, max_retries=0)
    user = (
        "Incoming invoice webhook payload (all amounts are integer pence):\n"
        + json.dumps(payload, indent=2, ensure_ascii=False)
        + "\n\nOpen purchase orders:\n"
        + json.dumps(open_pos(), indent=2)
    )
    kwargs = dict(
        model=model(),
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        tools=[PROPOSE_TOOL],
        messages=[{"role": "user", "content": user}],
    )
    try:
        resp = client.messages.create(tool_choice={"type": "tool", "name": "propose_payment"}, **kwargs)
    except anthropic.BadRequestError:
        # Some models reject forced tool_choice; the system prompt already names the tool.
        resp = client.messages.create(tool_choice={"type": "auto"}, **kwargs)
    for block in resp.content:
        if block.type == "tool_use" and block.name == "propose_payment":
            return dict(block.input)
    raise RuntimeError(f"no propose_payment call (stop_reason={resp.stop_reason})")


def propose(payload: dict) -> dict:
    """-> {invoice_id, vendor_id, amount, po_id, reasoning, source: "llm"|"fallback"|"compromised"}"""
    if payload.get("simulate") == "compromised_agent":
        # Demo of the worst case: the agent did whatever the invoice told it to.
        return {**fallback(payload), "reasoning": COMPROMISED_REASONING, "source": "compromised"}
    if mode() != "llm":
        return fallback(payload)
    try:
        inp = _call_claude(payload)
    except Exception as e:  # noqa: BLE001 - any failure falls back to the structured fields
        return fallback(payload, f"{type(e).__name__}: {e}"[:300])
    base = fallback(payload)
    amount = _int(inp.get("amount_pence"))
    reasoning = str(inp.get("reasoning") or "").strip() or "(no reasoning given)"
    if amount is not None and amount <= 0 and base["amount"]:
        # A £0 proposal is a no-op; propose the invoiced amount and let the gate decide.
        reasoning += f" [Agent proposed £0; the invoiced amount {base['amount']}p is used instead.]"
        amount = base["amount"]
    return {
        "invoice_id": str(inp.get("invoice_id") or "") or base["invoice_id"],
        "vendor_id": str(inp.get("vendor_id") or "") or base["vendor_id"],
        "amount": amount if amount is not None else base["amount"],
        "po_id": str(inp.get("po_id") or "") or base["po_id"],
        "api_key": base["api_key"],
        "nights": base["nights"],
        "reasoning": reasoning,
        "source": "llm",
    }
