"""V2.6 — E-Way Bill module backend tests."""
import os
import re
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    # fallback to frontend env
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("REACT_APP_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip().rstrip("/")

USERS = {
    "super_admin": ("admin@servall.com", "Admin@123"),
    "hub_accountant": ("accountant@servall.com", "Accountant@123"),
    "warehouse_manager": ("warehouse@servall.com", "Warehouse@123"),
    "franchise_manager": ("franchise@servall.com", "Franchise@123"),
}

EBN_PATTERN = re.compile(r"^EWB-\d{4}-\d{6}$")


def _login(role):
    email, password = USERS[role]
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, f"login {role}: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="session")
def tokens():
    return {role: _login(role) for role in USERS}


@pytest.fixture(scope="session")
def headers(tokens):
    return {role: {"Authorization": f"Bearer {t}"} for role, t in tokens.items()}


@pytest.fixture(scope="session")
def an_invoice(headers):
    r = requests.get(f"{BASE_URL}/api/tax-invoices", headers=headers["super_admin"])
    assert r.status_code == 200, r.text
    invs = r.json()
    # pick any
    assert invs, "no invoices seeded"
    return invs[0]


@pytest.fixture(scope="session")
def a_challan(headers):
    r = requests.get(f"{BASE_URL}/api/delivery-challans", headers=headers["super_admin"])
    assert r.status_code == 200, r.text
    dcs = r.json()
    assert dcs, "no DCs seeded"
    return dcs[0]


def _create_from_challan(headers, dc_id, role="super_admin", distance=250, vehicle="KA01AB1212"):
    payload = {
        "vehicle_number": vehicle,
        "transporter_name": "TestFreight",
        "distance_km": distance,
        "transport_mode": "road",
        "reason": "supply",
        "remarks": "test",
    }
    return requests.post(
        f"{BASE_URL}/api/eway-bills/from-challan/{dc_id}",
        headers=headers[role], json=payload,
    )


# B1
def test_b1_create_from_challan(headers, a_challan):
    r = _create_from_challan(headers, a_challan["id"], distance=250)
    assert r.status_code == 200, r.text
    d = r.json()
    assert EBN_PATTERN.match(d["eway_number"]), d["eway_number"]
    assert d["status"] == "active"
    assert d["provider"] == "LOCAL"
    # supplier+recipient snapshot present (gstin may be empty if org_settings has no gstin seeded)
    assert d["supplier"] and isinstance(d["supplier"], dict)
    assert d["recipient"] and isinstance(d["recipient"], dict)
    assert isinstance(d["line_items"], list)
    assert d["valid_from"] and d["valid_upto"]
    assert d["barcode_value"] == d["eway_number"]
    assert d["qr_payload"].startswith("EWB:")


# B2
def test_b2_create_from_invoice_and_backlink(headers, an_invoice):
    tid = an_invoice["id"]
    payload = {
        "vehicle_number": "KA02CD3434", "transporter_name": "InvFreight",
        "distance_km": 100, "transport_mode": "road", "reason": "supply",
    }
    r = requests.post(f"{BASE_URL}/api/eway-bills/from-invoice/{tid}",
                      headers=headers["super_admin"], json=payload)
    assert r.status_code == 200, r.text
    d = r.json()
    assert EBN_PATTERN.match(d["eway_number"])
    assert d["invoice_id"] == tid
    assert d["document_type"] == "Tax Invoice"
    # Backlink
    inv = requests.get(f"{BASE_URL}/api/tax-invoices/{tid}",
                       headers=headers["super_admin"]).json()
    assert inv.get("eway_bill_id")
    assert inv.get("eway_bill_number") == d["eway_number"]


# B3
def test_b3_sequential_numbering(headers, a_challan):
    nums = []
    for _ in range(3):
        r = _create_from_challan(headers, a_challan["id"])
        assert r.status_code == 200, r.text
        nums.append(r.json()["eway_number"])
    seqs = [int(n.split("-")[-1]) for n in nums]
    assert seqs[1] == seqs[0] + 1
    assert seqs[2] == seqs[1] + 1


# B4
def test_b4_list_filters(headers, a_challan):
    r = _create_from_challan(headers, a_challan["id"], vehicle="KA99XX9911")
    assert r.status_code == 200
    ewb = r.json()
    # filter by vehicle
    r2 = requests.get(f"{BASE_URL}/api/eway-bills?vehicle=KA99XX", headers=headers["super_admin"])
    assert r2.status_code == 200
    rows = r2.json()
    assert all("KA99XX" in (x.get("vehicle_number") or "").upper() for x in rows)
    assert any(x["id"] == ewb["id"] for x in rows)
    # filter by status active
    r3 = requests.get(f"{BASE_URL}/api/eway-bills?status=active", headers=headers["super_admin"])
    assert all(x["status"] == "active" for x in r3.json())
    # filter by q
    r4 = requests.get(f"{BASE_URL}/api/eway-bills?q=EWB-2026", headers=headers["super_admin"])
    assert r4.status_code == 200
    # filter by challan_id
    r5 = requests.get(f"{BASE_URL}/api/eway-bills?challan_id={a_challan['id']}",
                      headers=headers["super_admin"])
    assert all(x.get("challan_id") == a_challan["id"] for x in r5.json())


# B5
def test_b5_by_invoice_and_challan(headers, an_invoice, a_challan):
    r = requests.get(f"{BASE_URL}/api/eway-bills/by-invoice/{an_invoice['id']}",
                     headers=headers["super_admin"])
    assert r.status_code == 200
    # latest non-cancelled or {}
    body = r.json()
    if body:
        assert body["invoice_id"] == an_invoice["id"]
        assert body["status"] != "cancelled"
    r2 = requests.get(f"{BASE_URL}/api/eway-bills/by-challan/{a_challan['id']}",
                      headers=headers["super_admin"])
    assert r2.status_code == 200


# B6
def test_b6_update_transport(headers, a_challan):
    r = _create_from_challan(headers, a_challan["id"], distance=100)
    eid = r.json()["id"]
    old_valid = r.json()["valid_upto"]
    payload = {
        "vehicle_number": "KA77MM7777", "transporter_name": "Upd",
        "distance_km": 600, "transport_mode": "road", "reason": "supply",
    }
    r2 = requests.put(f"{BASE_URL}/api/eway-bills/{eid}",
                      headers=headers["super_admin"], json=payload)
    assert r2.status_code == 200, r2.text
    assert r2.json()["valid_upto"] != old_valid
    # cancel then update -> 409
    requests.post(f"{BASE_URL}/api/eway-bills/{eid}/cancel",
                  headers=headers["super_admin"], json={"reason": "test"})
    r3 = requests.put(f"{BASE_URL}/api/eway-bills/{eid}",
                      headers=headers["super_admin"], json=payload)
    assert r3.status_code == 409


# B7
def test_b7_cancel(headers, a_challan):
    r = _create_from_challan(headers, a_challan["id"])
    eid = r.json()["id"]
    r2 = requests.post(f"{BASE_URL}/api/eway-bills/{eid}/cancel",
                       headers=headers["super_admin"], json={"reason": "wrong vehicle"})
    assert r2.status_code == 200
    r3 = requests.get(f"{BASE_URL}/api/eway-bills/{eid}", headers=headers["super_admin"])
    assert r3.json()["status"] == "cancelled"
    assert r3.json().get("cancelled_reason") == "wrong vehicle"
    # second cancel -> 409
    r4 = requests.post(f"{BASE_URL}/api/eway-bills/{eid}/cancel",
                       headers=headers["super_admin"], json={"reason": "x"})
    assert r4.status_code == 409


# B8
def test_b8_duplicate(headers, a_challan):
    r = _create_from_challan(headers, a_challan["id"])
    src = r.json()
    eid = src["id"]
    r2 = requests.post(f"{BASE_URL}/api/eway-bills/{eid}/duplicate",
                       headers=headers["super_admin"])
    assert r2.status_code == 200, r2.text
    dup = r2.json()
    assert dup["id"] != eid
    assert dup["eway_number"] != src["eway_number"]
    assert dup["status"] == "active"
    assert dup["cancelled_at"] is None
    assert dup["supplier"]["gstin"] == src["supplier"]["gstin"]


# B9 — role checks
def test_b9_role_checks(headers, a_challan):
    # hub_accountant CAN create
    r = _create_from_challan(headers, a_challan["id"], role="hub_accountant")
    assert r.status_code == 200, r.text
    eid = r.json()["id"]
    # hub_accountant CAN cancel
    rc = requests.post(f"{BASE_URL}/api/eway-bills/{eid}/cancel",
                       headers=headers["hub_accountant"], json={"reason": "rc"})
    assert rc.status_code == 200
    # warehouse_manager cannot cancel
    r2 = _create_from_challan(headers, a_challan["id"], role="warehouse_manager")
    assert r2.status_code == 200
    eid2 = r2.json()["id"]
    rwc = requests.post(f"{BASE_URL}/api/eway-bills/{eid2}/cancel",
                        headers=headers["warehouse_manager"], json={"reason": "x"})
    assert rwc.status_code == 403
    # franchise_manager 403 on create
    rf = _create_from_challan(headers, a_challan["id"], role="franchise_manager")
    assert rf.status_code == 403
    # franchise_manager 403 on update/duplicate
    rfu = requests.put(f"{BASE_URL}/api/eway-bills/{eid2}",
                       headers=headers["franchise_manager"],
                       json={"vehicle_number": "x", "distance_km": 10,
                             "transport_mode": "road", "reason": "supply"})
    assert rfu.status_code == 403
    rfd = requests.post(f"{BASE_URL}/api/eway-bills/{eid2}/duplicate",
                        headers=headers["franchise_manager"])
    assert rfd.status_code == 403
    # franchise_manager CAN list (only their own)
    rfl = requests.get(f"{BASE_URL}/api/eway-bills", headers=headers["franchise_manager"])
    assert rfl.status_code == 200
    me = requests.get(f"{BASE_URL}/api/auth/me", headers=headers["franchise_manager"]).json()
    my_fid = me.get("franchise_id")
    for row in rfl.json():
        assert row.get("franchise_id") == my_fid, f"leak: {row}"


# B10 — PDF
def test_b10_pdf(headers, a_challan):
    r = _create_from_challan(headers, a_challan["id"])
    eid = r.json()["id"]
    fid = r.json().get("franchise_id")
    # super_admin
    rp = requests.get(f"{BASE_URL}/api/eway-bills/{eid}/pdf", headers=headers["super_admin"])
    assert rp.status_code == 200
    assert rp.headers["content-type"].startswith("application/pdf")
    assert rp.content.startswith(b"%PDF-1.4")
    assert len(rp.content) > 5000
    # warehouse_manager
    rw = requests.get(f"{BASE_URL}/api/eway-bills/{eid}/pdf", headers=headers["warehouse_manager"])
    assert rw.status_code == 200
    # franchise_manager — 403 if not their franchise
    me = requests.get(f"{BASE_URL}/api/auth/me", headers=headers["franchise_manager"]).json()
    if me.get("franchise_id") != fid:
        rfp = requests.get(f"{BASE_URL}/api/eway-bills/{eid}/pdf",
                           headers=headers["franchise_manager"])
        assert rfp.status_code == 403


# B11 — provider sanity
def test_b11_provider_local(headers, a_challan):
    r = _create_from_challan(headers, a_challan["id"])
    d = r.json()
    assert d["provider"] == "LOCAL"
    assert EBN_PATTERN.match(d["eway_number"])
    # PDF renders successfully (footer 'Provider: LOCAL' verified visually in F9)
    pdf = requests.get(f"{BASE_URL}/api/eway-bills/{d['id']}/pdf",
                       headers=headers["super_admin"])
    assert pdf.status_code == 200
    assert pdf.content.startswith(b"%PDF-1.4")
