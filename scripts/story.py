"""Fire the two demo-video story invoices (leaked API key, CEO hotel claim) at a running server.

    .venv/bin/python scripts/story.py [--url http://localhost:8000] [--gap 4]
"""
import argparse
import json
import time
from pathlib import Path

import httpx

STORY = sorted((Path(__file__).resolve().parent.parent / "fixtures" / "story").glob("*.json"))

ap = argparse.ArgumentParser()
ap.add_argument("--url", default="http://localhost:8000")
ap.add_argument("--gap", type=float, default=4.0)
args = ap.parse_args()
with httpx.Client(base_url=args.url, timeout=60) as c:
    for i, f in enumerate(STORY):
        if i:
            time.sleep(args.gap)
        p = c.post("/webhook/invoice", json=json.loads(f.read_text())).raise_for_status().json()
        print(f"{p['invoice']['invoice_id']:12} £{p['amount'] / 100:,.2f}  {p['status']:18} {p.get('stripe_pi_id') or ''}")
