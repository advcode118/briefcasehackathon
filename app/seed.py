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


VENDORS = {v.id: v for v in [
    Vendor("cloudco", "CloudCo Hosting", False),
    Vendor("printshop", "PrintShop Ltd", False),
    Vendor("labelbot", "LabelBot (AI data-labelling agent)", True),
    Vendor("quickfix", "QuickFix Supplies", False),
]}

POS = {po.id: po for po in [
    PO("PO-1", "cloudco", "engineering", "hosting", 10, 10, 20_00, "bob"),
    PO("PO-2", "printshop", "marketing", "print", 1, 1, 320_00, "bob"),
    PO("PO-3", "labelbot", "engineering", "data", 100, 100, 90, "alice"),
    PO("PO-4", "printshop", "marketing", "print", 10, 4, 15_00, "alice"),
    PO("PO-5", "quickfix", "operations", "supplies", 1, 1, 45_00, "alice"),
]}

APPROVERS = {"alice": "CFO", "bob": "Ops"}

AUTO_CAP = 5000_00     # P8 / T1: unapproved spend per 30 days
WINDOW_DAYS = 30
