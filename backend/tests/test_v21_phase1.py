"""V2.1 Phase 1 backend tests: franchise tiers, category overrides, multi-source
indents, bulk inventory import, editable POs, date-filtered endpoints, OCR config.

All tests run against the public REACT_APP_BACKEND_URL.
"""
import io
import os
import csv
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")


# --------- AUTH (V2.1 — verify all 4 demo accounts with new passwords) ---------
class TestAuthV21:
    @pytest.mark.parametrize("email,password,role", [
        ("admin@servall.com", "Admin@123", "super_admin"),
        ("accountant@servall.com", "Accountant@123", "hub_accountant"),
        ("warehouse@servall.com", "Warehouse@123", "warehouse_manager"),
        ("franchise@servall.com", "Franchise@123", "franchise_manager"),
    ])
    def test_login_all_seeded_roles(self, email, password, role):
        r = requests.post(f"{BASE_URL}/api/auth/login",
                          json={"email": email, "password": password}, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["user"]["role"] == role
        token = d["token"]
        assert isinstance(token, str) and len(token) > 20
        # /api/auth/me reflects role
        me = requests.get(f"{BASE_URL}/api/auth/me",
                          headers={"Authorization": f"Bearer {token}"}).json()
        assert me["role"] == role


# --------- FRANCHISE TIERS ---------
class TestFranchiseTiers:
    def test_list_seeded_tiers(self, admin_client):
        r = admin_client.get(f"{BASE_URL}/api/franchise-tiers")
        assert r.status_code == 200
        tiers = r.json()
        names = {t["name"]: t for t in tiers}
        # 4 system tiers must exist
        for nm, margin in [("MASTER", 18), ("STANDARD", 22), ("BUDDY", 25), ("PERFORMAX", 28)]:
            assert nm in names, f"missing tier {nm}"
            assert abs(float(names[nm]["margin_percent"]) - margin) < 0.001
            assert "category_overrides" in names[nm]
            assert isinstance(names[nm]["category_overrides"], list)

    def test_crud_custom_tier(self, admin_client):
        # CREATE
        payload = {"name": "TEST_TIER_X", "margin_percent": 20.0, "category_overrides": [], "color": "#abcdef"}
        r = admin_client.post(f"{BASE_URL}/api/franchise-tiers", json=payload)
        assert r.status_code == 200, r.text
        tier = r.json()
        tier_id = tier["id"]
        assert tier["name"] == "TEST_TIER_X"

        # PUT with category overrides
        upd = {"name": "TEST_TIER_X", "margin_percent": 20.0,
               "category_overrides": [{"category": "Engine Parts", "margin_percent": 15}],
               "color": "#abcdef", "active": True}
        r2 = admin_client.put(f"{BASE_URL}/api/franchise-tiers/{tier_id}", json=upd)
        assert r2.status_code == 200

        # Verify persisted
        listed = admin_client.get(f"{BASE_URL}/api/franchise-tiers").json()
        found = next(t for t in listed if t["id"] == tier_id)
        assert len(found["category_overrides"]) == 1
        assert found["category_overrides"][0]["category"] == "Engine Parts"
        assert float(found["category_overrides"][0]["margin_percent"]) == 15

        # DELETE
        r3 = admin_client.delete(f"{BASE_URL}/api/franchise-tiers/{tier_id}")
        assert r3.status_code == 200

    def test_cannot_delete_system_tier(self, admin_client):
        tiers = admin_client.get(f"{BASE_URL}/api/franchise-tiers").json()
        master = next(t for t in tiers if t["name"] == "MASTER")
        r = admin_client.delete(f"{BASE_URL}/api/franchise-tiers/{master['id']}")
        assert r.status_code == 403

    def test_tier_preview_with_category_override(self, admin_client):
        # Add Engine Parts override at 15% to MASTER tier and verify preview
        tiers = admin_client.get(f"{BASE_URL}/api/franchise-tiers").json()
        master = next(t for t in tiers if t["name"] == "MASTER")
        # Save the original to restore
        orig = {"name": master["name"], "margin_percent": master["margin_percent"],
                "category_overrides": master.get("category_overrides", []),
                "color": master.get("color", ""), "active": master.get("active", True)}
        try:
            upd = {**orig, "category_overrides": [{"category": "Engine Parts", "margin_percent": 15}]}
            r = admin_client.put(f"{BASE_URL}/api/franchise-tiers/{master['id']}", json=upd)
            assert r.status_code == 200
            prev = admin_client.get(f"{BASE_URL}/api/franchise-tiers/{master['id']}/preview")
            assert prev.status_code == 200
            data = prev.json()
            assert "rows" in data and len(data["rows"]) > 0
            ep_rows = [r for r in data["rows"] if (r.get("category") or "").lower() == "engine parts"]
            other_rows = [r for r in data["rows"] if (r.get("category") or "").lower() != "engine parts"]
            # All Engine Parts rows use 15%
            for r0 in ep_rows:
                assert abs(float(r0["margin_percent"]) - 15.0) < 0.001
            # Non-Engine-Parts rows fall back to base 18%
            if other_rows:
                # Most products fall back to tier base margin (18 for MASTER)
                base_margins = {float(r0["margin_percent"]) for r0 in other_rows}
                assert 18.0 in base_margins
        finally:
            admin_client.put(f"{BASE_URL}/api/franchise-tiers/{master['id']}", json=orig)

    def test_assign_tier_to_franchise(self, admin_client):
        tiers = admin_client.get(f"{BASE_URL}/api/franchise-tiers").json()
        master = next(t for t in tiers if t["name"] == "MASTER")
        franchises = admin_client.get(f"{BASE_URL}/api/franchises").json()
        fid = franchises[0]["id"]
        r = admin_client.put(f"{BASE_URL}/api/franchises/{fid}/tier",
                             json={"tier_id": master["id"]})
        assert r.status_code == 200


# --------- BULK INVENTORY IMPORT ---------
class TestBulkInventoryImport:
    TEMPLATE_HEADERS = [
        "SKU", "Part Number", "OEM Number", "Product Name", "Category", "HSN",
        "Barcode", "Rack Location", "Vendor", "Landing Price", "MRP",
        "Opening Stock", "Reorder Qty", "Safety Stock",
    ]

    def _make_csv(self, rows):
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(self.TEMPLATE_HEADERS)
        for row in rows:
            w.writerow(row)
        return buf.getvalue().encode("utf-8")

    def test_template_download(self, admin_client):
        r = admin_client.get(f"{BASE_URL}/api/inventory/template")
        assert r.status_code == 200
        # Should return an xlsx file
        assert len(r.content) > 100

    def test_validate_then_commit(self, admin_client):
        # Pick a vendor
        vendors = admin_client.get(f"{BASE_URL}/api/vendors").json()
        vendor_name = vendors[0]["name"]
        rows = [
            ["TEST_BULK_001", "PN001", "OEM001", "TEST_Bulk Part 1", "Engine Parts", "8708",
             "BC001", "A1-01", vendor_name, "100", "150", "25", "10", "5"],
            ["TEST_BULK_002", "PN002", "OEM002", "TEST_Bulk Part 2", "Brakes", "8708",
             "BC002", "A1-02", vendor_name, "200", "260", "0", "10", "5"],
        ]
        csv_bytes = self._make_csv(rows)
        files = {"file": ("bulk.csv", csv_bytes, "text/csv")}
        headers = {"Authorization": admin_client.headers["Authorization"]}
        r = requests.post(f"{BASE_URL}/api/inventory/import/validate",
                          files=files, headers=headers)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["total_rows"] == 2
        assert "upload_path" in d
        # Commit
        r2 = requests.post(f"{BASE_URL}/api/inventory/import/commit",
                           json={"upload_path": d["upload_path"], "overwrite_existing": True},
                           headers={**headers, "Content-Type": "application/json"})
        assert r2.status_code == 200, r2.text
        d2 = r2.json()
        # Should create 2 new products (or update if rerun)
        assert d2["ok"] is True
        assert d2.get("created", 0) + d2.get("updated", 0) >= 2

        # Verify products exist
        prods = admin_client.get(f"{BASE_URL}/api/products?q=TEST_Bulk").json()
        skus = {p["sku"] for p in prods}
        assert "TEST_BULK_001" in skus and "TEST_BULK_002" in skus

    def test_validate_rejects_bad_format(self, admin_client):
        bad = b"this is not a valid file"
        files = {"file": ("bad.txt", bad, "text/plain")}
        headers = {"Authorization": admin_client.headers["Authorization"]}
        r = requests.post(f"{BASE_URL}/api/inventory/import/validate",
                          files=files, headers=headers)
        assert r.status_code == 400


# --------- MULTI-SOURCE INDENTS ---------
class TestMultiSourceIndents:
    def test_legacy_indent_defaults_to_system(self, admin_client):
        fr = admin_client.get(f"{BASE_URL}/api/franchises").json()
        prods = admin_client.get(f"{BASE_URL}/api/products?limit=2").json()
        payload = {
            "franchise_id": fr[0]["id"], "priority": "routine", "notes": "TEST legacy system",
            "line_items": [{"product_id": prods[0]["id"], "requested_qty": 1}],
        }
        r = admin_client.post(f"{BASE_URL}/api/indents", json=payload)
        assert r.status_code == 200, r.text
        ind = r.json()
        # source field should be 'system' or absent (legacy compat)
        assert ind.get("source", "system") == "system"

    def test_indent_from_excel(self, admin_client):
        fr = admin_client.get(f"{BASE_URL}/api/franchises").json()
        prods = admin_client.get(f"{BASE_URL}/api/products?limit=2").json()
        sku1, sku2 = prods[0]["sku"], prods[1]["sku"]
        # Build CSV with sku/qty
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["sku", "qty"])
        w.writerow([sku1, 2])
        w.writerow([sku2, 3])
        csv_bytes = buf.getvalue().encode("utf-8")

        files = {"file": ("order.csv", csv_bytes, "text/csv")}
        data = {"franchise_id": fr[0]["id"], "priority": "routine", "notes": "TEST excel"}
        headers = {"Authorization": admin_client.headers["Authorization"]}
        r = requests.post(f"{BASE_URL}/api/indents/excel",
                          files=files, data=data, headers=headers)
        assert r.status_code == 200, r.text
        ind = r.json().get("indent", r.json())
        assert ind.get("source") == "excel"
        assert ind.get("source_attachment_url"), "source_attachment_url should be set"


# --------- EDITABLE PURCHASE ORDERS ---------
class TestEditablePO:
    def test_create_edit_pdf(self, admin_client):
        vendors = admin_client.get(f"{BASE_URL}/api/vendors").json()
        prods = admin_client.get(f"{BASE_URL}/api/products?limit=3").json()
        body = {
            "vendor_id": vendors[0]["id"], "notes": "TEST PO",
            "line_items": [
                {"product_id": prods[0]["id"], "quantity": 5, "unit_price": 100.0},
                {"product_id": prods[1]["id"], "quantity": 3, "unit_price": 200.0},
            ],
            "status": "draft",
        }
        r = admin_client.post(f"{BASE_URL}/api/purchase-orders", json=body)
        assert r.status_code == 200, r.text
        po = r.json()
        assert po["status"] == "draft"
        assert po["total_amount"] == 1100.0
        po_id = po["id"]

        # Edit draft
        body2 = {**body, "line_items": body["line_items"] + [{"product_id": prods[2]["id"], "quantity": 2, "unit_price": 50.0}]}
        r2 = admin_client.put(f"{BASE_URL}/api/purchase-orders/{po_id}", json=body2)
        assert r2.status_code == 200, r2.text

        # PDF download
        r3 = admin_client.get(f"{BASE_URL}/api/purchase-orders/{po_id}/pdf")
        assert r3.status_code == 200
        assert r3.headers.get("content-type", "").startswith("application/pdf")
        assert r3.content[:4] == b"%PDF"


# --------- DATE-FILTERED ENDPOINTS ---------
class TestFiltered:
    @pytest.mark.parametrize("path", [
        "/api/filtered/indents",
        "/api/filtered/invoices",
        "/api/filtered/purchase-orders",
        "/api/filtered/delivery-challans",
        "/api/filtered/stock-movements",
        "/api/filtered/audit-logs",
        "/api/filtered/dashboard-trend",
    ])
    def test_filtered_endpoint_with_date_params(self, admin_client, path):
        r = admin_client.get(f"{BASE_URL}{path}",
                             params={"date_from": "2025-01-01", "date_to": "2099-12-31"})
        assert r.status_code == 200, f"{path} -> {r.status_code} {r.text[:200]}"
        # Should return JSON
        try:
            data = r.json()
        except Exception:
            pytest.fail(f"{path} returned non-JSON")
        assert isinstance(data, (list, dict))


# --------- OCR CONFIG ---------
class TestOcrConfig:
    def test_ocr_aliases_endpoint(self, admin_client):
        r = admin_client.get(f"{BASE_URL}/api/ocr-aliases")
        assert r.status_code == 200
        assert isinstance(r.json(), list)
