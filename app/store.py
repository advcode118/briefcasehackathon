"""In-memory state, persisted to state.json on every mutation.

Holds the payments, the simulated day, the active policy version and the prover cache.
The state file path comes from PROVEN_STATE_PATH (default: <repo>/state.json) and is
read on every save, so tests can point it at a temp file.
"""
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_VERSION = "v4"
START_DAY = 1


def state_path() -> Path:
    return Path(os.environ.get("PROVEN_STATE_PATH") or ROOT / "state.json")


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Store:
    def __init__(self):
        self.lock = threading.RLock()
        self.payments: list[dict] = []
        self.day = START_DAY
        self.policy_version = DEFAULT_VERSION
        self.prove_cache: dict[str, dict] = {}
        self.next_payment = 1
        self.next_offline_pi = 1
        self.load()

    # ---- persistence -------------------------------------------------------
    def load(self) -> None:
        path = state_path()
        if not path.exists():
            return
        try:
            data = json.loads(path.read_text())
        except Exception:
            return
        with self.lock:
            self.payments = data.get("payments", [])
            self.day = data.get("day", START_DAY)
            self.policy_version = data.get("policy_version", DEFAULT_VERSION)
            self.prove_cache = data.get("prove_cache", {})
            self.next_payment = data.get("next_payment", len(self.payments) + 1)
            self.next_offline_pi = data.get("next_offline_pi", 1)

    def save(self) -> None:
        with self.lock:
            data = {
                "payments": self.payments,
                "day": self.day,
                "policy_version": self.policy_version,
                "prove_cache": self.prove_cache,
                "next_payment": self.next_payment,
                "next_offline_pi": self.next_offline_pi,
            }
            path = state_path()
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(path.suffix + ".tmp")
                tmp.write_text(json.dumps(data, indent=1, default=str))
                tmp.replace(path)
            except OSError:
                pass  # persistence is best effort; in-memory state is authoritative

    # ---- payments ----------------------------------------------------------
    def new_payment_id(self) -> str:
        with self.lock:
            pid = f"pay_{self.next_payment:04d}"
            self.next_payment += 1
            return pid

    def new_offline_pi(self) -> str:
        with self.lock:
            pid = f"pi_offline_{self.next_offline_pi}"
            self.next_offline_pi += 1
            self.save()
            return pid

    def add_payment(self, payment: dict) -> dict:
        with self.lock:
            self.payments.append(payment)
            self.save()
            return payment

    def get_payment(self, payment_id: str) -> dict | None:
        with self.lock:
            return next((p for p in self.payments if p["id"] == payment_id), None)

    def list_payments(self) -> list[dict]:
        with self.lock:
            return list(reversed(self.payments))

    def snapshot_payments(self) -> list[dict]:
        with self.lock:
            return list(self.payments)

    # ---- day / policy / prover ---------------------------------------------
    def advance_day(self) -> int:
        with self.lock:
            self.day += 1
            self.save()
            return self.day

    def set_policy_version(self, version: str) -> None:
        with self.lock:
            self.policy_version = version
            self.save()

    def set_prove(self, version: str, result: dict) -> None:
        with self.lock:
            self.prove_cache[version] = result
            self.save()

    def get_prove(self, version: str) -> dict | None:
        with self.lock:
            return self.prove_cache.get(version)

    def reset(self) -> None:
        """Clear payments and reseed the day; keeps the policy version and prove cache."""
        with self.lock:
            self.payments = []
            self.day = START_DAY
            self.next_payment = 1
            self.save()


store = Store()
