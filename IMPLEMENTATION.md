# Proven: implementation plan

The design is in `PLAN.md`. This file is the **build contract**: who builds what, and the exact interfaces between modules, so four workstreams can build in parallel without blocking each other.

Deadline: build freeze 20:25, video 20:30, submit by 21:00.

## 0. Ground rules

- Code lives at the repo root (`app/`, `static/`, …), not in a `proven/` subfolder.
- Python 3.11 via uv: run things with `.venv/bin/python`, `.venv/bin/pytest`, and `.venv/bin/uvicorn app.main:app --port 8000`.
- Money is **integer pence** everywhere, including the API. The frontend formats it as £.
- **Only edit the files your workstream owns.** If you need a change to someone else's file, say so in your final report.
- Do not commit. The lead commits.
- Already written, so don't change them without good reason: `app/seed.py` (vendors, POs, `AUTO_CAP`) and `app/ops.py` (`ConcreteOps`, `Z3Ops`, `Txn`, `Ctx`).
- Env (`.env`, loaded with python-dotenv in `main.py`): `STRIPE_SECRET_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` (default `claude-haiku-5-5`).
  - If `STRIPE_SECRET_KEY` is set and doesn't start with `sk_test_`, refuse to start.
  - If it's unset, run in **offline mode**: fake PaymentIntent IDs `pi_offline_<n>`, and the dashboard shows an "offline" badge. This lets everyone build before the keys arrive.

## 1. Workstreams

| WS | Owner | Files | Depends on |
|---|---|---|---|
| A. Core policy | agent | `app/rules.py`, `app/policy.py`, `app/gate.py`, `tests/test_consistency.py`, `tests/test_gate.py` | ops, seed |
| B. Backend | agent | `app/store.py`, `app/stripe_client.py`, `app/agent.py`, `app/main.py`, `fixtures/invoices/*.json`, `scripts/demo.py`, `tests/test_fixtures.py` | A's `gate.evaluate` signature (§2.3) |
| C. Frontend | agent | `static/index.html`, `static/settings.html`, `static/app.js` (+ `static/settings.js` if wanted) | API JSON (§3) only |
| D. Prover | agent | `app/prover.py`, `tests/test_prover.py` | A's `policy.decide` (§2.2) |
| Lead | me | `IMPLEMENTATION.md`, `README.md`, integration, end-to-end checks, Stripe check, commits | everything |

## 2. Python contracts

### 2.1 `rules.py` (WS A)

```python
@dataclass(frozen=True)
class Rule:
    id: str            # "P4"
    text: str          # plain English from PLAN §5.2
    decision: str      # "allow" | "escrow" | "hold" | "block" | "approval" (P12 only, never evaluated by the gate)
    condition: str     # monospace condition string for the settings page
    fires: Callable[[Txn, list[Txn], Ctx, ops], BoolExpr]
    explain: Callable[[Txn, list[Txn], Ctx], dict]   # concrete only -> {"detail": "£80 + £80 = £160 > £100", "evidence": ["history: INV-001 £80 on day 1"]}

RULES: dict[str, Rule]   # P4, P5, P6, P7, P8, P9, P10, P10_naive, P11, P12
```

- Every history sum has the form `ops.Sum([ops.If(ops.And(h.active, cond), h.amount, 0) for h in hist])`.
- P4 matches `ops.Or(h.active, h.pending)`. P7 and P8 count `h.active` (P8 also needs `h.auto`).
- `paid_against(po)`: history items already carry the effective amount (the captured amount once an escrow is captured).
- PO lookups go through `ops.lookup(p.po, ctx.po_limit, 0)` and similar. A missing PO is `p.po == ctx.no_po`.

### 2.2 `policy.py` (WS A)

```python
SEV = {"allow": 0, "escrow": 1, "hold": 2, "block": 3}
SEV_NAME = {v: k for k, v in SEV.items()}

@dataclass(frozen=True)
class Policy:
    version: str            # "v1".."v4"
    note: str               # one line, e.g. "v2: adds P7 (daily per-vendor approval)"
    rule_ids: list[str]     # the evaluated rules, in display order; v4 = P4..P11, plus "P12"
    hash: str               # 8 hex chars: sha256 over rule ids + inspect.getsource of each rule's fires

POLICIES: dict[str, Policy]  # v1..v4 as in PLAN §5.3 (v1 uses P10_naive; v4 uses P10)
def get_policy(version: str) -> Policy
def rules_of(policy) -> list[Rule]                               # evaluated rules only (excludes P12)
def fired(policy, p, hist, ctx, ops) -> dict[str, BoolExpr]      # rule_id -> fires expr
def decide(policy, p, hist, ctx, ops) -> IntExpr                 # max SEV over the fired rules (0 if none); uses ops.Max / ops.If
```

### 2.3 `gate.py` (WS A)

```python
EXECUTED = {"paid", "escrow_authorised", "escrow_captured"}

def history_from_payments(payments: list[dict]) -> list[Txn]
    # executed -> active=True, auto=payment["auto"], amount = captured_amount if escrow_captured else proposal amount
    # status == "held" -> active=False, pending=True
    # everything else is skipped

def proposal_txn(proposal: dict, day: int) -> Txn       # proposal["po_id"] None/"" -> ctx.no_po

def evaluate(proposal: dict, payments: list[dict], day: int, policy) -> dict:
    return {
      "decision": "hold",
      "deciding_rules": ["P7"],            # every fired rule at the max severity
      "execute_as": "allow" | "escrow",    # what approval would run: "escrow" if an escrow rule fired
      "trace": [ {"rule_id", "text", "decision", "fired": bool, "detail": str, "evidence": [str]} ],  # all evaluated rules, in order
      "verdict": "Held by P7: CloudCo already received £80 today; £80 + £80 = £160 > £100.",  # template, not LLM
      "auto_spend_before": int,            # executed auto spend in the 30-day window before this payment (map dot y)
      "policy_version": "v4", "policy_hash": "a1b2c3d4",
    }

def fmt_gbp(pence: int) -> str   # "£80", "£0.90", "£5,000"
```

### 2.4 `prover.py` (WS D)

```python
THEOREMS: dict[str, str]   # id -> statement (T1, T2, T3, T5, T6, T7, T8)
def prove_all(version: str, n: int = 60) -> dict   # the /api/prove shape in §3, without "running"
```

- The bounded model, theorems and worst case are in PLAN §6. Slot decisions **must** come from `policy.decide(policy, slot_txn, earlier_slot_txns, Ctx.symbolic(), Z3Ops)`, with no re-implemented rules.
- Inside the prover, `pending = False` for every slot.
- Expected results: v1: T1 ✗, T2 ✗, T5 ✗; v2: T1 ✗, T5 ✗; v3: T5 ✗; v4: all ✓. T3, T6 and T7 are ✓ in every version. Worst case under v4 is £5,000.
- Each theorem gets a per-check timeout (`solver.set("timeout", ms)`). Aim for < 10 s per theorem.

### 2.5 Backend modules (WS B)

- `store.py`: a thread-safe singleton holding `payments: list[dict]`, `day: int`, `policy_version: str`, `prove_cache: dict[version, result]`. Persisted to `state.json` on every mutation. `reset()` reseeds.
- `stripe_client.py`: `create(payment, vendor, decision, policy) -> {"id", "status"}`, `capture(pi_id, amount) -> {...}`, `cancel(pi_id) -> {...}`. Calls are exactly as in PLAN §8. Offline mode returns fake objects.
- `agent.py`: `propose(payload: dict) -> dict {invoice_id, vendor_id, amount, po_id, reasoning, source: "llm"|"fallback"}`. Uses Claude tool use with a forced `propose_payment` tool call. Falls back to the structured fields on no key or any error. The prompt doesn't mention the rules.
- `main.py`: the routes in §3. Serves `static/` at `/static`, `index.html` at `/`, `settings.html` at `/settings`. On startup it kicks off the prover for the active version in a background thread (and for v1–v4 after that, so the demo switches instantly).

## 3. HTTP API (contract between WS B and WS C)

Payment object, as returned by every payment route:

```json
{
  "id": "pay_0001", "created_at": "2026-10-15T19:30:01Z", "day": 1,
  "invoice": {"invoice_id": "INV-001", "vendor_id": "cloudco", "amount": 8000, "po_id": "PO-1", "day": 1, "body": "..."},
  "proposal": {"invoice_id": "INV-001", "vendor_id": "cloudco", "amount": 8000, "po_id": "PO-1",
               "reasoning": "...", "source": "llm"},
  "vendor_name": "CloudCo Hosting", "amount": 8000,
  "decision": "hold", "deciding_rules": ["P7"], "execute_as": "allow",
  "status": "held",            // paid | escrow_authorised | escrow_captured | escrow_cancelled | held | rejected | blocked
  "auto": false,
  "trace": [{"rule_id": "P7", "text": "...", "decision": "hold", "fired": true, "detail": "£80 + £80 = £160 > £100", "evidence": ["..."]}],
  "verdict": "Held by P7: ...",
  "approvals": [{"approver": "bob", "ok": false, "reason": "P12: bob requested PO-2, so can't approve it", "at": "..."}],
  "stripe_pi_id": "pi_...", "stripe_status": "succeeded", "stripe_url": "https://dashboard.stripe.com/test/payments/pi_...",
  "captured_amount": 6300, "delivered_qty": 70, "ordered_qty": 100,
  "policy_version": "v4", "policy_hash": "a1b2c3d4", "auto_spend_before": 8000
}
```

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/webhook/invoice` | invoice payload (PLAN §9); `day` defaults to the store's day | Payment |
| POST | `/webhook/delivery` | `{payment_id, delivered_qty}` | Payment (capture `amount × delivered / ordered`, or cancel if 0) |
| GET | `/api/payments` | | `[Payment]`, newest first |
| GET | `/api/payments/{id}` | | Payment |
| POST | `/api/payments/{id}/approve` | `{approver}` | Payment (P12 refusal → still held, approval logged `ok: false`) |
| POST | `/api/payments/{id}/reject` | `{approver}` | Payment |
| GET | `/api/summary` | | `{day, total_paid, held, blocked, escrow, auto_spend_window, auto_cap, stripe_mode: "test"\|"offline", agent_mode: "llm"\|"fallback"}` |
| GET | `/api/policy` | | `{version, hash, note, versions: [{id, note}], rules: [{id, text, decision, condition, active}]}` (rules = all of P4–P12 + P10_naive, `active` for this version) |
| POST | `/api/policy/version` | `{version}` | same as GET `/api/policy` |
| GET | `/api/prove?version=v4` | | prove result (cached; `status: "pending"` if not run yet) |
| POST | `/api/prove` | `{version?}` | starts a background run, returns current result with `running: true` |
| POST | `/api/day/advance` | | summary |
| POST | `/api/reset` | | summary (clears payments, day = 1, keeps the prove cache) |

Prove result:

```json
{
  "version": "v2", "hash": "...", "n": 60, "running": false,
  "theorems": [
    {"id": "T1", "statement": "Unapproved spend in 30 days ≤ £5,000", "status": "proved|attack|timeout|error|pending",
     "seconds": 3.1,
     "counterexample": {"summary": "£6,000 unapproved in 30 days via 60 payments across 3 vendors",
                        "payments": [{"day": 0, "vendor": "cloudco", "po": "PO-1", "amount": 10000, "invoice_id": 17, "auto": true}]}}
  ],
  "worst_case": {"status": "optimal|timeout|pending", "value": 500000, "seconds": 12.0}
}
```

## 4. Schedule (BST)

| Time | Milestone |
|---|---|
| 19:05 | A, B, C, D launched in parallel |
| 19:25 | A done: gate and consistency test green. D wires its model to `policy.decide` |
| 19:40 | B done: curl webhook → Payment, offline or real Stripe. C renders the feed and trace from the live API |
| 19:50 | D done: T1/T2/T3/T5 give the expected results across v1–v4. **P0 complete** |
| 20:05 | Lead: end-to-end with real keys, `demo.py` against Stripe test mode, browser pass on both pages |
| 20:20 | README, polish, commit, push the public repo |
| 20:25 | Freeze. Record the video from the PLAN §11 script |

P1 items (settings map, Claude agent, T6/T7, worst case, mini map) are built by their owning workstream straight after their P0 work. P2 (T8, "would be allowed if…", Cognee) only if there's time.

## 5. Decisions made during the build

- **PO-1's requester is bob, not alice.** With alice as requester, P12 refused her approval of fixture 2, which PLAN §11 says she approves. With bob as requester, fixture 2 shows a second, unscripted P12 refusal if bob tries.
- **Fixture 4 is held by P6 and P7.** A single £320 payment is already over the £100 per-vendor daily limit, so both rules fire.
- **Fixture 3 is blocked by P4 alone only while fixture 2 is still held.** If fixture 2 is approved first, P10 fires as well (£160 + £80 > £200).
- **"Passed all N rules" counts only the rules the gate evaluates:** 8 under v4. P12 is checked at approval time.

## 6. Known modelling caveats (go in the README)

- The proof is **bounded**: ≤ N = 60 payments per 30-day window, against the seed PO table.
- In the prover, approvals are modelled as `active ∧ ¬auto` slots in slot order. A real approval can come later than the payments after it. This doesn't affect T1, because approved spend isn't auto spend.
- The prover models one 30-day window. P8 uses a sliding window, so the proof covers any single window.
