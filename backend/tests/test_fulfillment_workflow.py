"""Tests for the new Indent fulfillment workflow + masking + audit trail."""
import os
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")


# ---------- Helper: create a fresh indent with stocked products ----------
def _create_indent(admin_client, qty1=3, qty2=2):
    fr = admin_client.get(f"{BASE_URL}/api/franchises").json()
    prods = admin_client.get(f"{BASE_URL}/api/products?limit=20").json()
    stocked = [p for p in prods if p.get("hub_stock", 0) >= max(qty1, qty2) + 2]
    assert len(stocked) >= 2, "need at least 2 stocked products"
    payload = {
        "franchise_id": fr[0]["id"],
        "priority": "routine",
        "notes": "TEST fulfillment workflow",
        "line_items": [
            {"product_id": stocked[0]["id"], "requested_qty": qty1},
            {"product_id": stocked[1]["id"], "requested_qty": qty2},
        ],
    }
    r = admin_client.post(f"{BASE_URL}/api/indents", json=payload)
    assert r.status_code == 200, r.text
    return r.json(), stocked


# ---------- 1. Fulfill: partial -> partially_fulfilled, then fulfilled ----------
class TestFulfillPartialThenFull:
    def test_partial_fulfill_then_remaining(self, admin_client):
        indent, prods = _create_indent(admin_client, qty1=3, qty2=2)
        iid = indent["id"]
        p1, p2 = prods[0], prods[1]
        hub1_before = p1["hub_stock"]

        # partial: only 1 of product1, 0 of product2
        r = admin_client.post(f"{BASE_URL}/api/indents/{iid}/fulfill", json={
            "items": [
                {"product_id": p1["id"], "fulfill_qty": 1},
                {"product_id": p2["id"], "fulfill_qty": 0},
            ]
        })
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["status"] == "partially_fulfilled"
        assert 0 < j["fulfillment_ratio"] < 100

        # hub stock decremented by 1
        p1_after = admin_client.get(f"{BASE_URL}/api/products/{p1['id']}").json()
        assert p1_after["hub_stock"] == hub1_before - 1

        # backorder set on line item
        ind = admin_client.get(f"{BASE_URL}/api/indents/{iid}").json()
        li1 = next(li for li in ind["line_items"] if li["product_id"] == p1["id"])
        assert li1["allocated_qty"] == 1
        assert li1["backorder_qty"] == 2

        # complete the rest
        r2 = admin_client.post(f"{BASE_URL}/api/indents/{iid}/fulfill", json={
            "items": [
                {"product_id": p1["id"], "fulfill_qty": 2},
                {"product_id": p2["id"], "fulfill_qty": 2},
            ]
        })
        assert r2.status_code == 200, r2.text
        assert r2.json()["status"] == "fulfilled"
        assert r2.json()["fulfillment_ratio"] == 100.0

    def test_fulfill_exceeds_pending_qty(self, admin_client):
        indent, prods = _create_indent(admin_client, qty1=2, qty2=1)
        iid = indent["id"]
        r = admin_client.post(f"{BASE_URL}/api/indents/{iid}/fulfill", json={
            "items": [{"product_id": prods[0]["id"], "fulfill_qty": 999}],
        })
        assert r.status_code == 400
        assert "exceeds pending" in r.json().get("detail", "").lower() or \
               "exceeds" in r.json().get("detail", "").lower()

    def test_fulfill_zero_everything_rejected(self, admin_client):
        indent, prods = _create_indent(admin_client)
        iid = indent["id"]
        r = admin_client.post(f"{BASE_URL}/api/indents/{iid}/fulfill", json={
            "items": [
                {"product_id": prods[0]["id"], "fulfill_qty": 0},
                {"product_id": prods[1]["id"], "fulfill_qty": 0},
            ]
        })
        assert r.status_code == 400


# ---------- 2. Reject flow ----------
class TestRejectIndent:
    def test_reject_sets_status_and_notification(self, admin_client, franchise_client):
        indent, _ = _create_indent(admin_client)
        iid = indent["id"]
        r = requests.post(
            f"{BASE_URL}/api/indents/{iid}/reject",
            data={"reason": "TEST stock unavailable"},
            headers={"Authorization": admin_client.headers["Authorization"]},
        )
        assert r.status_code == 200, r.text

        ind = admin_client.get(f"{BASE_URL}/api/indents/{iid}").json()
        assert ind["status"] == "rejected"
        assert "TEST stock unavailable" in ind.get("rejection_reason", "")


# ---------- 3. pending-stock summary ----------
class TestPendingStockSummary:
    def test_returns_can_now_fulfill(self, admin_client, warehouse_client):
        indent, prods = _create_indent(admin_client, qty1=3, qty2=2)
        # partial leaves backorder
        admin_client.post(f"{BASE_URL}/api/indents/{indent['id']}/fulfill", json={
            "items": [{"product_id": prods[0]["id"], "fulfill_qty": 1}],
        })
        r = warehouse_client.get(f"{BASE_URL}/api/indents/pending-stock/summary")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)
        # find one of our backordered lines
        match = [row for row in data if row["indent_id"] == indent["id"]]
        assert len(match) >= 1
        row = match[0]
        for k in ["hub_available", "can_now_fulfill", "pending_qty",
                  "indent_number", "product_name"]:
            assert k in row

    def test_franchise_forbidden(self, franchise_client):
        r = franchise_client.get(f"{BASE_URL}/api/indents/pending-stock/summary")
        assert r.status_code == 403


# ---------- 4. Stock movements audit trail ----------
class TestStockMovements:
    def test_admin_can_list(self, admin_client):
        r = admin_client.get(f"{BASE_URL}/api/stock-movements?limit=50")
        assert r.status_code == 200
        rows = r.json()
        assert isinstance(rows, list)
        if rows:
            row = rows[0]
            for k in ["delta", "qty_before", "qty_after", "product_id",
                      "reference_type", "timestamp"]:
                assert k in row, f"missing {k}"
            # immutability invariant
            assert row["qty_after"] == row["qty_before"] + row["delta"]

    def test_franchise_forbidden(self, franchise_client):
        r = franchise_client.get(f"{BASE_URL}/api/stock-movements")
        assert r.status_code == 403

    def test_filter_by_product(self, admin_client):
        prods = admin_client.get(f"{BASE_URL}/api/products?limit=5").json()
        pid = prods[0]["id"]
        r = admin_client.get(f"{BASE_URL}/api/stock-movements?product_id={pid}")
        assert r.status_code == 200
        for row in r.json():
            assert row["product_id"] == pid

    def test_fulfill_creates_stock_movement(self, admin_client):
        indent, prods = _create_indent(admin_client, qty1=2, qty2=1)
        iid = indent["id"]
        admin_client.post(f"{BASE_URL}/api/indents/{iid}/fulfill", json={
            "items": [{"product_id": prods[0]["id"], "fulfill_qty": 1}],
        })
        r = admin_client.get(
            f"{BASE_URL}/api/stock-movements?reference_id={iid}&reference_type=indent"
        )
        assert r.status_code == 200
        rows = r.json()
        assert len(rows) >= 1
        assert rows[0]["reference_id"] == iid
        assert rows[0]["delta"] < 0  # outflow from hub


# ---------- 5. Products masking for franchise role ----------
class TestProductsMasking:
    FORBIDDEN = {"hub_stock", "franchise_stock", "total_stock",
                 "landing_price", "margin_percent", "safety_stock",
                 "reorder_qty", "low_stock", "primary_vendor_id"}

    def test_franchise_products_have_no_stock_or_cost(self, franchise_client):
        r = franchise_client.get(f"{BASE_URL}/api/products?limit=10")
        assert r.status_code == 200
        items = r.json()
        assert len(items) >= 1
        for p in items:
            leaked = self.FORBIDDEN & set(p.keys())
            assert not leaked, f"Franchise saw forbidden keys: {leaked}"
            # safe keys still present
            for k in ["id", "sku", "name", "mrp", "franchise_price"]:
                assert k in p

    def test_franchise_single_product_masked(self, franchise_client, admin_client):
        prods = admin_client.get(f"{BASE_URL}/api/products?limit=1").json()
        pid = prods[0]["id"]
        r = franchise_client.get(f"{BASE_URL}/api/products/{pid}")
        assert r.status_code == 200
        p = r.json()
        leaked = self.FORBIDDEN & set(p.keys())
        assert not leaked

    def test_admin_still_sees_stock(self, admin_client):
        r = admin_client.get(f"{BASE_URL}/api/products?limit=2")
        items = r.json()
        for p in items:
            for k in ["hub_stock", "franchise_stock", "total_stock"]:
                assert k in p


# ---------- 6. Dashboard masking ----------
class TestDashboardMasking:
    def test_franchise_dashboard_minimal(self, franchise_client):
        r = franchise_client.get(f"{BASE_URL}/api/dashboard/stats")
        assert r.status_code == 200
        d = r.json()
        assert d.get("is_franchise") is True
        for k in ["my_pending", "my_fulfilled", "my_dispatched",
                  "my_delivered", "trend_7d"]:
            assert k in d, f"missing {k}"
        # Must NOT contain sensitive aggregates
        for forbidden in ["total_stock_value", "low_stock_count",
                          "outstanding_payments", "dead_stock_count",
                          "top_products"]:
            assert forbidden not in d, f"Franchise leaked {forbidden}"

    def test_admin_dashboard_full(self, admin_client):
        r = admin_client.get(f"{BASE_URL}/api/dashboard/stats")
        d = r.json()
        assert d.get("is_franchise") is False
        for k in ["total_stock_value", "low_stock_count",
                  "outstanding_payments", "pending_fulfillment_queue"]:
            assert k in d


# ---------- 7. Franchise indent scoping ----------
class TestIndentScoping:
    def test_franchise_only_sees_own(self, franchise_client, franchise_user):
        r = franchise_client.get(f"{BASE_URL}/api/indents")
        assert r.status_code == 200
        fid = franchise_user.get("franchise_id")
        for ind in r.json():
            assert ind["franchise_id"] == fid


# ---------- 8. Dispatch with allocated_qty only ----------
class TestDispatchAfterFulfill:
    def test_dispatch_after_partial_fulfill(self, admin_client):
        indent, prods = _create_indent(admin_client, qty1=2, qty2=2)
        iid = indent["id"]
        # only allocate product1
        admin_client.post(f"{BASE_URL}/api/indents/{iid}/fulfill", json={
            "items": [{"product_id": prods[0]["id"], "fulfill_qty": 2}],
        })
        # status is partially_fulfilled - dispatch should work
        r = requests.post(
            f"{BASE_URL}/api/indents/{iid}/dispatch",
            data={"transporter_name": "TEST Trans", "vehicle_number": "MH99XY1234"},
            headers={"Authorization": admin_client.headers["Authorization"]},
        )
        assert r.status_code == 200, r.text
        dc = r.json()["dc"]
        # DC must only contain the allocated item
        skus = [li["sku"] for li in dc["line_items"]]
        assert prods[0]["sku"] in skus
        # not the unallocated one
        assert prods[1]["sku"] not in skus

        # indent status moved to dispatched
        ind = admin_client.get(f"{BASE_URL}/api/indents/{iid}").json()
        assert ind["status"] == "dispatched"

    def test_dispatch_before_fulfill_fails(self, admin_client):
        indent, _ = _create_indent(admin_client)
        iid = indent["id"]
        r = requests.post(
            f"{BASE_URL}/api/indents/{iid}/dispatch",
            data={"transporter_name": "x"},
            headers={"Authorization": admin_client.headers["Authorization"]},
        )
        assert r.status_code == 409


# ---------- 9. Full happy path ----------
class TestHappyPath:
    def test_full_lifecycle_warehouse(self, admin_client, warehouse_client):
        indent, prods = _create_indent(admin_client, qty1=2, qty2=2)
        iid = indent["id"]
        # warehouse fulfills
        r = warehouse_client.post(f"{BASE_URL}/api/indents/{iid}/fulfill", json={
            "items": [
                {"product_id": prods[0]["id"], "fulfill_qty": 2},
                {"product_id": prods[1]["id"], "fulfill_qty": 2},
            ]
        })
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "fulfilled"

        # dispatch
        rd = requests.post(
            f"{BASE_URL}/api/indents/{iid}/dispatch",
            data={"transporter_name": "TEST"},
            headers={"Authorization": warehouse_client.headers["Authorization"]},
        )
        assert rd.status_code == 200

        # deliver
        rdv = warehouse_client.post(f"{BASE_URL}/api/indents/{iid}/deliver")
        assert rdv.status_code == 200

        ind = admin_client.get(f"{BASE_URL}/api/indents/{iid}").json()
        assert ind["status"] == "delivered"

        # franchise stock should have increased
        movements = admin_client.get(
            f"{BASE_URL}/api/stock-movements?reference_id={iid}"
        ).json()
        # at minimum: 2 outflows (fulfill) + 2 inflows (deliver) = 4
        assert len(movements) >= 4
