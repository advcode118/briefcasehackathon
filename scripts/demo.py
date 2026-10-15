"""Reset the demo and fire the 8 fixture invoices (PLAN §11) at a running server.

    .venv/bin/python scripts/demo.py [--url http://localhost:8000] [--gap 2] [--no-reset]
"""
import argparse
import json
import sys
import time
from pathlib import Path

import httpx

FIXTURES = sorted((Path(__file__).resolve().parent.parent / "fixtures" / "invoices").glob("*.json"))


def gbp(pence) -> str:
    if pence is None:
        return "?"
    pounds, p = divmod(int(pence), 100)
    return f"£{pounds:,}" if p == 0 else f"£{pounds:,}.{p:02d}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--gap", type=float, default=2.0, help="seconds between invoices")
    ap.add_argument("--no-reset", action="store_true", help="don't POST /api/reset first")
    args = ap.parse_args()

    with httpx.Client(base_url=args.url, timeout=60) as c:
        if not args.no_reset:
            s = c.post("/api/reset").raise_for_status().json()
            print(f"reset: day {s['day']}, stripe {s['stripe_mode']}, agent {s['agent_mode']}, "
                  f"policy {s.get('policy_version', '?')}")
        for i, f in enumerate(FIXTURES):
            if i:
                time.sleep(args.gap)
            inv = json.loads(f.read_text())
            r = c.post("/webhook/invoice", json=inv)
            if r.status_code != 200:
                print(f"{f.stem:<18} HTTP {r.status_code}: {r.text[:200]}")
                continue
            p = r.json()
            rules = ",".join(p["deciding_rules"]) or "-"
            print(f"{p['id']}  {inv['invoice_id']:<8} {p['vendor_name'][:18]:<18} {gbp(p['amount']):>7}  "
                  f"{p['decision']:<6} {rules:<8} {p['status']:<18} {p.get('stripe_pi_id') or ''}"
                  f"  [{p['proposal'].get('source')}]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
