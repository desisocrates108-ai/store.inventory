#!/usr/bin/env python3
"""
V2.5 Phase 2 — Sticker / Label Module Backend API Tests
Tests all endpoints for Template CRUD, Preview-data binding, and Print Jobs audit log.
"""
import requests
import json
import sys
from typing import Optional

# Backend URL from frontend/.env
BASE_URL = "https://starter-kit-complete.preview.emergentagent.com/api"

# Test credentials
CREDENTIALS = {
    "super_admin": {"email": "admin@servall.com", "password": "Admin@123"},
    "hub_accountant": {"email": "accountant@servall.com", "password": "Accountant@123"},
    "warehouse_manager": {"email": "warehouse@servall.com", "password": "Warehouse@123"},
    "franchise_manager": {"email": "franchise@servall.com", "password": "Franchise@123"},
}

# Global tokens cache
tokens = {}

# Test results tracking
test_results = {
    "passed": 0,
    "failed": 0,
    "failures": []
}


def log_test(name: str, passed: bool, details: str = ""):
    """Log test result."""
    status = "✅ PASS" if passed else "❌ FAIL"
    print(f"{status}: {name}")
    if details:
        print(f"  Details: {details}")
    
    if passed:
        test_results["passed"] += 1
    else:
        test_results["failed"] += 1
        test_results["failures"].append({
            "test": name,
            "details": details
        })


def login(role: str) -> Optional[str]:
    """Login and return JWT token."""
    if role in tokens:
        return tokens[role]
    
    creds = CREDENTIALS.get(role)
    if not creds:
        print(f"❌ No credentials for role: {role}")
        return None
    
    try:
        resp = requests.post(f"{BASE_URL}/auth/login", json=creds, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            token = data.get("token")
            tokens[role] = token
            print(f"✅ Logged in as {role}")
            return token
        else:
            print(f"❌ Login failed for {role}: {resp.status_code} {resp.text}")
            return None
    except Exception as e:
        print(f"❌ Login exception for {role}: {e}")
        return None


def get_headers(role: str) -> dict:
    """Get authorization headers for a role."""
    token = login(role)
    if not token:
        return {}
    return {"Authorization": f"Bearer {token}"}


def test_template_crud():
    """Test A: Template CRUD operations."""
    print("\n" + "="*80)
    print("TEST A: Template CRUD + duplicate")
    print("="*80)
    
    # A1: Create template as super_admin
    print("\n[A1] POST /api/sticker-templates as super_admin")
    headers = get_headers("super_admin")
    payload = {
        "name": "Test Template",
        "sticker_type": "small_product",
        "width_mm": 50,
        "height_mm": 30
    }
    
    try:
        resp = requests.post(f"{BASE_URL}/sticker-templates", json=payload, headers=headers, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            template_id = data.get("id")
            
            # Verify response structure
            checks = [
                ("has id", template_id is not None),
                ("sticker_type is small_product", data.get("sticker_type") == "small_product"),
                ("dpi default is 203", data.get("dpi") == 203),
                ("canvas_json has version", data.get("canvas_json", {}).get("version") == "6"),
                ("canvas_json has objects", "objects" in data.get("canvas_json", {})),
                ("active is true", data.get("active") is True),
            ]
            
            all_passed = all(check[1] for check in checks)
            details = "; ".join([f"{check[0]}: {check[1]}" for check in checks])
            log_test("A1: Create template as super_admin", all_passed, details)
            
            if not template_id:
                print("❌ CRITICAL: No template_id returned, cannot continue tests")
                return None
                
        else:
            log_test("A1: Create template as super_admin", False, 
                    f"Status {resp.status_code}: {resp.text[:200]}")
            return None
    except Exception as e:
        log_test("A1: Create template as super_admin", False, f"Exception: {e}")
        return None
    
    # A2: Create as hub_accountant (should succeed), warehouse_manager (should succeed), franchise_manager (should fail 403)
    print("\n[A2] Test role-based access for POST /api/sticker-templates")
    
    # hub_accountant → 200
    headers_acc = get_headers("hub_accountant")
    payload_acc = {
        "name": "Accountant Template",
        "sticker_type": "small_product",
        "width_mm": 40,
        "height_mm": 25
    }
    try:
        resp = requests.post(f"{BASE_URL}/sticker-templates", json=payload_acc, headers=headers_acc, timeout=10)
        log_test("A2a: hub_accountant can create template", resp.status_code == 200,
                f"Status: {resp.status_code}")
    except Exception as e:
        log_test("A2a: hub_accountant can create template", False, f"Exception: {e}")
    
    # warehouse_manager → 200
    headers_wh = get_headers("warehouse_manager")
    payload_wh = {
        "name": "Warehouse Template",
        "sticker_type": "small_product",
        "width_mm": 45,
        "height_mm": 28
    }
    try:
        resp = requests.post(f"{BASE_URL}/sticker-templates", json=payload_wh, headers=headers_wh, timeout=10)
        log_test("A2b: warehouse_manager can create template", resp.status_code == 200,
                f"Status: {resp.status_code}")
    except Exception as e:
        log_test("A2b: warehouse_manager can create template", False, f"Exception: {e}")
    
    # franchise_manager → 403
    headers_fm = get_headers("franchise_manager")
    payload_fm = {
        "name": "Franchise Template",
        "sticker_type": "small_product",
        "width_mm": 50,
        "height_mm": 30
    }
    try:
        resp = requests.post(f"{BASE_URL}/sticker-templates", json=payload_fm, headers=headers_fm, timeout=10)
        log_test("A2c: franchise_manager gets 403", resp.status_code == 403,
                f"Status: {resp.status_code}")
    except Exception as e:
        log_test("A2c: franchise_manager gets 403", False, f"Exception: {e}")
    
    # A3: GET /api/sticker-templates as admin returns list including new template
    print("\n[A3] GET /api/sticker-templates")
    try:
        resp = requests.get(f"{BASE_URL}/sticker-templates", headers=headers, timeout=10)
        if resp.status_code == 200:
            templates = resp.json()
            found = any(t.get("id") == template_id for t in templates)
            log_test("A3: List templates includes created template", found,
                    f"Found {len(templates)} templates, target present: {found}")
        else:
            log_test("A3: List templates", False, f"Status {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        log_test("A3: List templates", False, f"Exception: {e}")
    
    # A4: GET ?sticker_type=small_product narrows the list
    print("\n[A4] GET /api/sticker-templates?sticker_type=small_product")
    try:
        resp = requests.get(f"{BASE_URL}/sticker-templates?sticker_type=small_product", 
                          headers=headers, timeout=10)
        if resp.status_code == 200:
            templates = resp.json()
            all_small = all(t.get("sticker_type") == "small_product" for t in templates)
            log_test("A4: Filter by sticker_type", all_small,
                    f"Found {len(templates)} templates, all small_product: {all_small}")
        else:
            log_test("A4: Filter by sticker_type", False, f"Status {resp.status_code}")
    except Exception as e:
        log_test("A4: Filter by sticker_type", False, f"Exception: {e}")
    
    # A5: GET ?q=Test filters by name (case-insensitive substring)
    print("\n[A5] GET /api/sticker-templates?q=Test")
    try:
        resp = requests.get(f"{BASE_URL}/sticker-templates?q=Test", headers=headers, timeout=10)
        if resp.status_code == 200:
            templates = resp.json()
            all_match = all("test" in t.get("name", "").lower() for t in templates)
            log_test("A5: Filter by name query", all_match,
                    f"Found {len(templates)} templates, all contain 'test': {all_match}")
        else:
            log_test("A5: Filter by name query", False, f"Status {resp.status_code}")
    except Exception as e:
        log_test("A5: Filter by name query", False, f"Exception: {e}")
    
    # A6: PUT /api/sticker-templates/{id} updates name
    print("\n[A6] PUT /api/sticker-templates/{id}")
    update_payload = {
        "name": "Test Template v2",
        "sticker_type": "small_product",
        "width_mm": 50,
        "height_mm": 30
    }
    try:
        resp = requests.put(f"{BASE_URL}/sticker-templates/{template_id}", 
                          json=update_payload, headers=headers, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            name_updated = data.get("name") == "Test Template v2"
            has_updated_at = "updated_at" in data
            log_test("A6: Update template name", name_updated and has_updated_at,
                    f"Name updated: {name_updated}, has updated_at: {has_updated_at}")
        else:
            log_test("A6: Update template name", False, f"Status {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        log_test("A6: Update template name", False, f"Exception: {e}")
    
    # A7: POST /api/sticker-templates/{id}/duplicate returns new id with "(copy)" suffix
    print("\n[A7] POST /api/sticker-templates/{id}/duplicate")
    try:
        resp = requests.post(f"{BASE_URL}/sticker-templates/{template_id}/duplicate", 
                           headers=headers, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            new_id = data.get("id")
            name = data.get("name", "")
            is_copy = new_id != template_id and "(copy)" in name
            log_test("A7: Duplicate template", is_copy,
                    f"New ID: {new_id != template_id}, Name has (copy): {'(copy)' in name}")
            duplicate_id = new_id
        else:
            log_test("A7: Duplicate template", False, f"Status {resp.status_code}: {resp.text[:200]}")
            duplicate_id = None
    except Exception as e:
        log_test("A7: Duplicate template", False, f"Exception: {e}")
        duplicate_id = None
    
    # A8: DELETE /api/sticker-templates/{id} as super_admin → soft delete
    print("\n[A8] DELETE /api/sticker-templates/{id}")
    try:
        resp = requests.delete(f"{BASE_URL}/sticker-templates/{template_id}", 
                             headers=headers, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            ok = data.get("ok") is True
            
            # Verify soft delete - GET should still return doc but with active=false
            resp_get = requests.get(f"{BASE_URL}/sticker-templates/{template_id}", 
                                  headers=headers, timeout=10)
            if resp_get.status_code == 200:
                doc = resp_get.json()
                is_inactive = doc.get("active") is False
                log_test("A8a: Delete template (soft delete)", ok and is_inactive,
                        f"ok: {ok}, active=false: {is_inactive}")
            else:
                log_test("A8a: Delete template (soft delete)", False, 
                        f"GET after delete failed: {resp_get.status_code}")
        else:
            log_test("A8a: Delete template (soft delete)", False, 
                    f"Status {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        log_test("A8a: Delete template (soft delete)", False, f"Exception: {e}")
    
    # A8b: DELETE as hub_accountant → 403
    print("\n[A8b] DELETE as hub_accountant → 403")
    if duplicate_id:
        try:
            resp = requests.delete(f"{BASE_URL}/sticker-templates/{duplicate_id}", 
                                 headers=headers_acc, timeout=10)
            log_test("A8b: hub_accountant cannot delete", resp.status_code == 403,
                    f"Status: {resp.status_code}")
        except Exception as e:
            log_test("A8b: hub_accountant cannot delete", False, f"Exception: {e}")
    
    return template_id


def test_preview_data():
    """Test B: Preview-data binding endpoint."""
    print("\n" + "="*80)
    print("TEST B: Preview-data binding")
    print("="*80)
    
    headers = get_headers("super_admin")
    
    # B1: GET /api/sticker-templates/preview-data WITHOUT product_id
    print("\n[B1] GET /api/sticker-templates/preview-data (no product_id)")
    try:
        resp = requests.get(f"{BASE_URL}/sticker-templates/preview-data", 
                          headers=headers, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            
            # Check for required keys
            required_keys = [
                "sku", "name", "brand", "category", "hsn", "vehicle_compatibility",
                "mrp", "selling_price", "franchise_price", "landing_price",
                "batch_number", "mfg_date", "quantity", "barcode_value", "qr_value",
                "company_name", "today"
            ]
            
            missing_keys = [k for k in required_keys if k not in data]
            has_all_keys = len(missing_keys) == 0
            
            # Verify sample values (not 404 or error)
            has_sample_sku = data.get("sku") == "SAMPLE-001"
            
            log_test("B1: Preview-data without product_id", has_all_keys and has_sample_sku,
                    f"All keys present: {has_all_keys}, Sample SKU: {has_sample_sku}, Missing: {missing_keys}")
        else:
            log_test("B1: Preview-data without product_id", False,
                    f"Status {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        log_test("B1: Preview-data without product_id", False, f"Exception: {e}")
    
    # B2: Get a real product ID first
    print("\n[B2] GET /api/sticker-templates/preview-data?product_id=<real>")
    try:
        # Get products list
        resp_products = requests.get(f"{BASE_URL}/products?limit=1", headers=headers, timeout=10)
        if resp_products.status_code == 200:
            products = resp_products.json()
            if products and len(products) > 0:
                product_id = products[0].get("id")
                product_sku = products[0].get("sku")
                
                # Get preview data with product_id
                resp = requests.get(f"{BASE_URL}/sticker-templates/preview-data?product_id={product_id}",
                                  headers=headers, timeout=10)
                if resp.status_code == 200:
                    data = resp.json()
                    sku_matches = data.get("sku") == product_sku
                    log_test("B2: Preview-data with real product_id", sku_matches,
                            f"SKU matches product: {sku_matches}")
                else:
                    log_test("B2: Preview-data with real product_id", False,
                            f"Status {resp.status_code}: {resp.text[:200]}")
            else:
                log_test("B2: Preview-data with real product_id", False, "No products found")
        else:
            log_test("B2: Preview-data with real product_id", False, 
                    f"Failed to get products: {resp_products.status_code}")
    except Exception as e:
        log_test("B2: Preview-data with real product_id", False, f"Exception: {e}")
    
    # B3: GET with random UUID → 404
    print("\n[B3] GET /api/sticker-templates/preview-data?product_id=<random>")
    try:
        import uuid
        random_id = str(uuid.uuid4())
        resp = requests.get(f"{BASE_URL}/sticker-templates/preview-data?product_id={random_id}",
                          headers=headers, timeout=10)
        log_test("B3: Preview-data with random product_id returns 404", resp.status_code == 404,
                f"Status: {resp.status_code}")
    except Exception as e:
        log_test("B3: Preview-data with random product_id returns 404", False, f"Exception: {e}")


def test_print_jobs():
    """Test C: Print Job audit log endpoints."""
    print("\n" + "="*80)
    print("TEST C: Print Job audit log")
    print("="*80)
    
    # First create a template to use
    headers_admin = get_headers("super_admin")
    template_payload = {
        "name": "Print Test Template",
        "sticker_type": "small_product",
        "width_mm": 50,
        "height_mm": 30
    }
    
    try:
        resp = requests.post(f"{BASE_URL}/sticker-templates", json=template_payload, 
                           headers=headers_admin, timeout=10)
        if resp.status_code == 200:
            template_id = resp.json().get("id")
            print(f"✅ Created test template: {template_id}")
        else:
            print(f"❌ Failed to create test template: {resp.status_code}")
            return
    except Exception as e:
        print(f"❌ Exception creating test template: {e}")
        return
    
    # C1: POST /api/sticker-print-jobs as warehouse_manager
    print("\n[C1] POST /api/sticker-print-jobs as warehouse_manager")
    headers_wh = get_headers("warehouse_manager")
    job_payload = {
        "template_id": template_id,
        "qty_strategy": "one_each",
        "output_format": "pdf",
        "printer_label": "Zebra-DEV",
        "product_ids": ["aaaa", "bbbb"],
        "total_stickers": 2
    }
    
    try:
        resp = requests.post(f"{BASE_URL}/sticker-print-jobs", json=job_payload, 
                           headers=headers_wh, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            job_id_1 = data.get("id")
            
            checks = [
                ("has id", job_id_1 is not None),
                ("product_count is 2", data.get("product_count") == 2),
                ("total_stickers is 2", data.get("total_stickers") == 2),
                ("has user_id", data.get("user_id") is not None),
                ("has user_name", data.get("user_name") is not None),
                ("has ip_address", "ip_address" in data),
                ("has created_at", data.get("created_at") is not None),
            ]
            
            all_passed = all(check[1] for check in checks)
            details = "; ".join([f"{check[0]}: {check[1]}" for check in checks])
            log_test("C1: Create print job as warehouse_manager", all_passed, details)
        else:
            log_test("C1: Create print job as warehouse_manager", False,
                    f"Status {resp.status_code}: {resp.text[:200]}")
            return
    except Exception as e:
        log_test("C1: Create print job as warehouse_manager", False, f"Exception: {e}")
        return
    
    # C2: POST as franchise_manager → 200 (no role restriction)
    print("\n[C2] POST /api/sticker-print-jobs as franchise_manager")
    headers_fm = get_headers("franchise_manager")
    job_payload_2 = {
        "template_id": template_id,
        "qty_strategy": "one_each",
        "output_format": "pdf",
        "printer_label": "Zebra-DEV",
        "product_ids": ["cccc", "dddd"],
        "total_stickers": 2
    }
    
    try:
        resp = requests.post(f"{BASE_URL}/sticker-print-jobs", json=job_payload_2,
                           headers=headers_fm, timeout=10)
        log_test("C2: franchise_manager can create print job", resp.status_code == 200,
                f"Status: {resp.status_code}")
        if resp.status_code == 200:
            job_id_2 = resp.json().get("id")
        else:
            job_id_2 = None
    except Exception as e:
        log_test("C2: franchise_manager can create print job", False, f"Exception: {e}")
        job_id_2 = None
    
    # C3: POST with non-existent template_id → 404
    print("\n[C3] POST /api/sticker-print-jobs with non-existent template_id")
    import uuid
    fake_template_id = str(uuid.uuid4())
    job_payload_3 = {
        "template_id": fake_template_id,
        "qty_strategy": "one_each",
        "output_format": "pdf",
        "printer_label": "Zebra-DEV",
        "product_ids": ["eeee"],
        "total_stickers": 1
    }
    
    try:
        resp = requests.post(f"{BASE_URL}/sticker-print-jobs", json=job_payload_3,
                           headers=headers_admin, timeout=10)
        log_test("C3: Non-existent template_id returns 404", resp.status_code == 404,
                f"Status: {resp.status_code}")
    except Exception as e:
        log_test("C3: Non-existent template_id returns 404", False, f"Exception: {e}")
    
    # C4: GET /api/sticker-print-jobs → list, newest-first
    print("\n[C4] GET /api/sticker-print-jobs")
    try:
        resp = requests.get(f"{BASE_URL}/sticker-print-jobs", headers=headers_admin, timeout=10)
        if resp.status_code == 200:
            jobs = resp.json()
            has_jobs = len(jobs) >= 2
            # Check if newest first (created_at should be descending)
            if len(jobs) >= 2:
                newest_first = jobs[0].get("created_at", "") >= jobs[1].get("created_at", "")
            else:
                newest_first = True
            
            log_test("C4: List print jobs", has_jobs and newest_first,
                    f"Found {len(jobs)} jobs, newest first: {newest_first}")
        else:
            log_test("C4: List print jobs", False, f"Status {resp.status_code}")
    except Exception as e:
        log_test("C4: List print jobs", False, f"Exception: {e}")
    
    # C5: GET /api/sticker-print-jobs?template_id=<id>
    print("\n[C5] GET /api/sticker-print-jobs?template_id=<id>")
    try:
        resp = requests.get(f"{BASE_URL}/sticker-print-jobs?template_id={template_id}",
                          headers=headers_admin, timeout=10)
        if resp.status_code == 200:
            jobs = resp.json()
            all_match = all(j.get("template_id") == template_id for j in jobs)
            log_test("C5: Filter print jobs by template_id", all_match,
                    f"Found {len(jobs)} jobs, all match template: {all_match}")
        else:
            log_test("C5: Filter print jobs by template_id", False, f"Status {resp.status_code}")
    except Exception as e:
        log_test("C5: Filter print jobs by template_id", False, f"Exception: {e}")
    
    # C6: GET /api/sticker-print-jobs/{jid}/reprint-payload
    print("\n[C6] GET /api/sticker-print-jobs/{jid}/reprint-payload")
    if job_id_1:
        try:
            resp = requests.get(f"{BASE_URL}/sticker-print-jobs/{job_id_1}/reprint-payload",
                              headers=headers_admin, timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                has_job = "job" in data
                has_template = "template" in data
                log_test("C6: Get reprint payload", has_job and has_template,
                        f"Has job: {has_job}, Has template: {has_template}")
            else:
                log_test("C6: Get reprint payload", False, f"Status {resp.status_code}")
        except Exception as e:
            log_test("C6: Get reprint payload", False, f"Exception: {e}")


def test_existing_pytest_suite():
    """Test D: Run existing pytest suite."""
    print("\n" + "="*80)
    print("TEST D: Existing pytest suite")
    print("="*80)
    
    import subprocess
    import os
    
    print("\n[D] Running pytest suite...")
    try:
        env = os.environ.copy()
        env["MONGO_URL"] = "mongodb://localhost:27017"
        env["DB_NAME"] = "servall_erp_test"
        
        result = subprocess.run(
            ["python3", "-m", "pytest", "tests/", "-x", "-q"],
            cwd="/app/backend",
            env=env,
            capture_output=True,
            text=True,
            timeout=120
        )
        
        output = result.stdout + result.stderr
        print(output)
        
        # Check if 142 tests passed
        passed = "142 passed" in output
        log_test("D: Existing pytest suite (142 tests)", passed,
                f"Exit code: {result.returncode}, Output contains '142 passed': {passed}")
        
    except subprocess.TimeoutExpired:
        log_test("D: Existing pytest suite (142 tests)", False, "Timeout after 120s")
    except Exception as e:
        log_test("D: Existing pytest suite (142 tests)", False, f"Exception: {e}")


def print_summary():
    """Print test summary."""
    print("\n" + "="*80)
    print("TEST SUMMARY")
    print("="*80)
    print(f"✅ Passed: {test_results['passed']}")
    print(f"❌ Failed: {test_results['failed']}")
    print(f"Total: {test_results['passed'] + test_results['failed']}")
    
    if test_results['failures']:
        print("\n" + "="*80)
        print("FAILURES DETAIL")
        print("="*80)
        for failure in test_results['failures']:
            print(f"\n❌ {failure['test']}")
            print(f"   {failure['details']}")
    
    return test_results['failed'] == 0


def main():
    """Run all tests."""
    print("="*80)
    print("V2.5 Phase 2 — Sticker / Label Module Backend API Tests")
    print("="*80)
    print(f"Backend URL: {BASE_URL}")
    
    # Run tests
    test_template_crud()
    test_preview_data()
    test_print_jobs()
    test_existing_pytest_suite()
    
    # Print summary
    success = print_summary()
    
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
