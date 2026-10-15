# ProofPay: demo video script (≈2 min)

**Before recording**
- Server: `.venv/bin/uvicorn app.main:app --port 8000` (cached proofs are in `state.json`; set `PROVEN_NO_PROVER=1`).
- Load 30 days of history: `.venv/bin/python scripts/demo.py --gap 0`.
- Open three tabs:
  1. ProofPay Payments, `localhost:8000`.
  2. ProofPay Policies, `localhost:8000/settings`.
  3. Stripe test dashboard → Payments, logged in to the account whose key is in `.env`.
- Keep a terminal ready with `.venv/bin/python scripts/story.py --gap 6` (it fires the two story invoices live).

---

## 1. Intro (0:00–0:25)

**Problem** *(on screen: Payments page, scrolled to the history)*
> "Firms are handing AI agents the company card. Today the only thing between an agent and your money is a prompt asking it to behave. And money leaks in boring ways too: a leaked API key, a duplicate invoice, an expense that's a bit too generous."

**Solution**
> "ProofPay is an accounts-payable agent for Hale & Whitcombe, a law firm. Claude reads every invoice and expense claim and proposes a payment. It can't pay anything itself. Every proposal goes through the firm's written policies, and every decision comes with a reason you can read."

## 2. Demo (0:25–1:20)

*(Run `story.py` now. Two new rows arrive at the top a few seconds apart, and the "Agent activity" log updates.)*

**Refused: the intern's leaked API key** *(click the £742 Aster AI row)*
> "At 3am, £742 of AI API usage hit our card: 18,000 requests in six hours. An intern had created a key on a personal account and pushed it to a public repo."
> *(point to the step trail)* "Claude read the bill and proposed paying it, which is reasonable. It's a real invoice from a real vendor."
> *(point to the failed check)* "Our AI spend policy says API usage must be billed to a key registered to the firm's GitHub org. This key belongs to `jdoe-intern`, not `hale-whitcombe`. Refused. Stripe was never called, so no money moved."

**Accepted: the CEO's hotel** *(click the £1,140 expense-claim row)*
> "Same agent, legitimate spend. Our CEO claims three nights in New York for £1,140."
> *(checklist)* "That's £380 a night against our £400 cap. It sits inside the trip's pre-approval, it's under the travel limits, it isn't a duplicate. All 19 checks passed."
> *(click "view in Stripe ↗" and cut to the Stripe tab)* "And here's the real PaymentIntent in Stripe, with the invoice, the policy version and the rules checked written into its metadata."

## 3. How it works (1:20–2:00)

**How we give input** *(Policies page, top)*
> "Finance writes policies by category: general controls, AI spend, travel, software, food and drink, insurance. Each rule is a short plain-English line backed by code. Invoices arrive at a webhook; email ingestion is next."

**The formal part** *(scroll to Guarantees)*
> "Because Claude only proposes and a deterministic gate decides, we can do more than test the policy: we prove things about it. A theorem prover, Z3, checks every possible sequence of payments. For example, unapproved spend can never exceed £500,000 in 30 days, and an invoice can never be paid twice. The gate and the prover run the same rule code, so the policy we prove is the policy we enforce."

**Close**
> "ProofPay: let the agent spend, and know what it can't do."

---

## What is real in this demo (for Q&A)

- **Real:** the Claude calls (`claude-haiku-5-5`), the Stripe test-mode PaymentIntents, the policy checks, and the Z3 proofs.
- **Built in:** the firm, vendors, purchase orders, API-key registry, the GitHub org name and the invoices are seed data. Timestamps are backdated so the history covers 30 days.
- **The proofs are bounded:** up to 60 payments per 30-day window, against the seed purchase orders.
  - The API-key and hotel-per-night rules aren't modelled in the prover: its payments carry no key and no nights. Those rules only ever refuse or hold, so they can't break a proved guarantee, but nothing is proved *about* them specifically.
- **One invoice is simulated:** MOP-7790 (£95,000, with injected instructions) is flagged `simulate: compromised_agent`, so its proposal is what a fooled agent would send. Real Claude wasn't fooled in our tests.
