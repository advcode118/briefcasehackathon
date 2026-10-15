"""Seed data: vendors, purchase orders, approvers. All money in integer pence."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Vendor:
    id: str
    name: str
    is_agent: bool


@dataclass(frozen=True)
class PO:
    id: str
    vendor_id: str
    department: str
    category: str
    ordered_qty: int
    received_qty: int
    unit_price: int
    requester: str

    @property
    def limit(self) -> int:
        return self.received_qty * self.unit_price


# Demo company: Hale & Whitcombe LLP, a London law firm.
VENDORS = {v.id: v for v in [
    Vendor("casebase", "Casebase Legal Research", False),
    Vendor("northline", "Northline eDiscovery", False),
    Vendor("harbour", "Harbour Court Reporting", False),
    Vendor("lexa", "Lexa AI (contract-review agent)", True),
    Vendor("aster", "Aster AI (LLM API)", False),
    Vendor("sterling", "Sterling Expert Witnesses", False),
    Vendor("meridian", "Meridian Office & Print", False),
    Vendor("kestrel", "Kestrel Insurance Brokers", False),
    Vendor("northbound", "Northbound Travel Management", False),
    Vendor("larder", "Larder & Co Catering", False),
    Vendor("brief", "Brief Practice Software", False),
    Vendor("ceo-claims", "Margaret Hale (CEO) — expense claim", False),
]}

POS = {po.id: po for po in [
    PO("PO-101", "casebase", "knowledge", "Software", 12, 10, 4_200_00, "bob"),
    PO("PO-102", "northline", "litigation", "eDiscovery", 5, 5, 8_500_00, "bob"),
    PO("PO-103", "harbour", "litigation", "Court reporting", 20, 12, 1_150_00, "alice"),
    PO("PO-104", "lexa", "corporate", "AI spend", 1000, 1000, 9_00, "alice"),
    PO("PO-105", "aster", "technology", "AI spend", 12, 10, 6_200_00, "bob"),
    PO("PO-106", "sterling", "litigation", "Expert witnesses", 3, 2, 9_500_00, "alice"),
    PO("PO-107", "meridian", "operations", "Office & print", 1, 1, 2_400_00, "alice"),
    PO("PO-108", "kestrel", "finance", "Insurance", 12, 10, 9_800_00, "bob"),
    PO("PO-109", "northbound", "operations", "Travel", 10, 10, 3_500_00, "bob"),
    PO("PO-110", "larder", "operations", "Food & drink", 20, 12, 800_00, "bob"),
    PO("PO-111", "brief", "technology", "Software", 12, 10, 3_900_00, "bob"),
    PO("TA-112", "ceo-claims", "management", "Travel", 1, 1, 2_000_00, "bob"),   # travel pre-approval: NYC trip
]}

# AI API keys and the GitHub org that provisioned them (synced from the org's secrets inventory).
GIT_ORG = "hale-whitcombe"
API_KEYS = {
    "ak_hw_drafting_01": "hale-whitcombe",     # contract drafting assistant (prod)
    "ak_hw_research_02": "hale-whitcombe",     # research tooling
    "ak_7f3a_personal": "jdoe-intern",         # created on a personal account, pushed to a public repo
}
HOTEL_NIGHTLY_CAP = 400_00

# Categories with their own policies (rules.CATEGORY_RULES); other POs fall under "General" only.
CATEGORIES = ["AI spend", "Travel", "Software", "Food & drink", "Insurance"]

APPROVERS = {"alice": "CFO", "bob": "Ops"}

AUTO_CAP = 500_000_00     # P8 / T1: unapproved spend per 30 days
WINDOW_DAYS = 30
