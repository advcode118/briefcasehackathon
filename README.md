# Proven

**A payments agent whose spending policy is proven, not prompted.**
Briefcase × Stripe hackathon, Track 1 "Agents that spend".

An invoice arrives at a webhook. A Claude agent reads it and **proposes** a payment. A deterministic **gate** checks the proposal against a written policy and decides whether to pay, escrow, hold for a human, or block. Allowed payments become **Stripe test-mode PaymentIntents**, and escrow uses manual capture with a partial capture on delivery. Every decision stores a **trace**: which rules were checked, with the real numbers plugged in.

Separately, a **Z3 prover** proves theorems about the policy itself. One example: "the agent can never move more than £5,000 in 30 days without a human". When a theorem is false, the prover returns the exact sequence of payments that breaks it.

- **The LLM is untrusted.** It only proposes, so prompt injection can't move money.
- **The gate is deterministic.** Every decision cites the rules and the evidence behind it.
- **The policy is proven loophole-free,** within a stated bound (see "What the proof covers").

```
POST /webhook/invoice → agent (Claude) proposes → gate checks the policy → Stripe test mode → trace → dashboard
                                                       ↑
                                       prover (Z3) proves theorems about the same rule code
```

## What's real and what's built in

| Part | Status |
|---|---|
| Stripe | Real PaymentIntents in **test mode** on Stripe's test card (`pm_card_visa`), with the vendor recorded in metadata. There are no payouts to vendors; a real build would use Connect transfers. The app refuses to start with a key that isn't `sk_test_`. |
| Agent | A real Claude call (`claude-haiku-5-5`) with a forced `propose_payment` tool. Without `ANTHROPIC_API_KEY` it falls back to the invoice's structured fields. The agent is never told the rules. |
| Prompt-injection fixture | Invoice #6 is flagged `simulate: compromised_agent`: the proposal is what an agent fooled by the injection would send (£9,000), and the UI labels it **simulated compromised agent**. In our tests, real Claude wasn't fooled and proposed the £45 PO amount instead. The demo shows that the gate blocks the payment even when the agent *is* fooled. |
| Vendors, POs, approvers | Hand-written seed data (`app/seed.py`). |
| Policy | Rules P4–P12 hand-written in Python (`app/rules.py`). There is no policy compiler. |
| Time | A simulated day counter (0–29), advanced from the settings page. |
| State | In memory, persisted to `state.json`. No database, no auth. |

## The policy (v4)

| ID | Rule | Decision |
|---|---|---|
| P4 | Never pay the same invoice twice | block |
| P5 | No single payment over £500 | block |
| P6 | Payments over £100 need approval | hold |
| P7 | Over £100 to one vendor in one day needs approval | hold |
| P8 | Unapproved spend capped at £5,000 per 30 days | hold |
| P9 | Every payment needs a matching purchase order | hold |
| P10 | Never pay more than what arrived, at the contract price (cumulative per PO) | block |
| P11 | Buying from another agent over £50 goes through escrow | escrow |
| P12 | Whoever requested the PO can't approve the payment | approval refused |

The decision is the most severe rule that fires (block > hold > escrow > allow), so rules can't conflict. Versions v1–v3 are earlier drafts with loopholes. The prover finds them, and v4 fixes them.

## Shared semantics: the proved policy is the enforced policy

Each rule is written **once**, against an `ops` object (`app/ops.py`):
- The gate runs the rule with `ConcreteOps` on real payments.
- The prover runs the same function with `Z3Ops`, which builds Z3 terms over symbolic payments.

`tests/test_consistency.py` checks that both give the same decision on 200 random histories plus edge cases, under every policy version.

## What the proof covers

Results from `app/prover.py` (Z3, N = 60 payment slots per 30-day window, seed PO table). ✓ = proved (the negation is unsat); ✗ = attack found.

| Theorem | v1 | v2 | v3 | v4 |
|---|---|---|---|---|
| T1 Unapproved spend in 30 days ≤ £5,000 | ✗ | ✗ | ✓ | ✓ |
| T2 No vendor gets > £100 in a day without approval | ✗ | ✓ | ✓ | ✓ |
| T3 No invoice is ever paid twice | ✓ | ✓ | ✓ | ✓ |
| T5 Paid against a PO ≤ received × contract price | ✗ | ✗ | ✗ | ✓ |
| T6 Escrow conserves money | ✓ | ✓ | ✓ | ✓ |
| T7 A valid invoice is always paid automatically | ✓ | ✓ | ✓ | ✓ |

- **Worst-case unapproved exposure** is computed with `z3.Optimize`.
  - **v4: £715 exactly.** Every unapproved payment needs a PO (P9), and P10 caps each PO cumulatively, so the maximum is the sum of the open PO limits (£200 + £320 + £90 + £60 + £45). The £5,000 cap (T1) is an independent ceiling that holds whatever the POs are.
  - **v3: exactly £5,000.** There the cap is the binding limit, because the naive P10 lets one PO be reused.
- **Attacks are real.** `tests/test_prover.py` replays every counterexample through the concrete gate, payment by payment. It checks that the gate admits each one and that the bound really is broken.

- **Bounded:** proved for up to N payments per 30-day window, against the seed PO table. N is large enough that the bound isn't what makes T1 true (N × £100 > £5,000).
- **Approvals:** the prover treats approved payments as executed, non-automatic payments, in arrival order. In reality an approval can come later, but that doesn't affect T1, because approved spend isn't "unapproved spend".
- **Window:** one 30-day window is modelled. P8 is a sliding window, so the result holds for any single window.
- **Scope:** the theorems are about the policy. They don't cover Stripe, the network, or the code outside the rule functions.

## Run it

```bash
uv sync -p 3.11
cp .env.example .env        # add STRIPE_SECRET_KEY=sk_test_... and, optionally, ANTHROPIC_API_KEY
.venv/bin/uvicorn app.main:app --port 8000
# open http://localhost:8000 (dashboard) and http://localhost:8000/settings (policy, proofs, map)
.venv/bin/python scripts/demo.py           # resets state, then fires the 8 demo invoices 2 s apart
.venv/bin/pytest -q                        # consistency, gate, fixture and prover tests
```

Without `STRIPE_SECRET_KEY` the app runs offline with fake PaymentIntent IDs.

## Demo invoices (`fixtures/invoices/`)

| # | Invoice | Expected |
|---|---|---|
| 1 | INV-001, CloudCo £80, PO-1 | paid |
| 2 | INV-002, CloudCo £80, PO-1 | held by P7 (£160 > £100 today); alice approves, so it's paid |
| 3 | INV-001 resent | blocked by P4 (duplicate) |
| 4 | INV-003, PrintShop £320, PO-2 | held by P6/P7; bob is refused by P12, alice approves |
| 5 | INV-004, LabelBot £90, PO-3 | escrow by P11; 70/100 delivered, so £63 is captured and £27 released |
| 6 | INV-005, QuickFix £9,000 + prompt injection (simulated compromised agent) | blocked by P5 and P10 |
| 7 | INV-006, PrintShop £90, PO-4 | blocked by P10 (received 4 × £15 = £60) |
| 8 | INV-007, CloudCo, no PO | held by P9 |

## API

`POST /webhook/invoice`, `POST /webhook/delivery`, `GET /api/payments[/{id}]`, `POST /api/payments/{id}/approve|reject`, `GET /api/summary`, `GET|POST /api/policy[/version]`, `GET|POST /api/prove`, `POST /api/day/advance`, `POST /api/reset`. See `IMPLEMENTATION.md` §3 for the shapes.

## What's next

Email invoice ingestion; KYC'd vendors as Stripe Connect accounts, with a theorem that money only reaches verified accounts; agent-proposed rule changes accepted only if worst-case exposure stays under the CFO's ceiling; many agents sharing one proven budget; and agent-to-agent escrow negotiation.
