#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

user_problem_statement: |
  V2.5 Phase 2 — Sticker / Label Module (independent of inventory).
  Features 7-15 from the user spec:
    F7  — Left-nav "Sticker Printing" module.
    F8  — fabric.js drag/resize/rotate designer with grid/zoom/undo/redo/layers/align/duplicate/preview/print.
    F9  — Auto product data binding via {{placeholders}} resolved against /sticker-templates/preview-data.
    F10 — Batch printing with strategies: 1 per product / inventory_qty / custom.
    F11 — Printer-agnostic architecture (window.print + PDF export now; ZPL/EPL deferred).
    F12 — Template library (CRUD + Save As / duplicate / soft delete).
    F13 — Barcode + QR via bwip-js (Code128, EAN13, EAN8, UPC-A, UPC-E, Code39, QR).
    F14 — Print history audit log (sticker_print_jobs collection).
    F15 — Reusable engine: stickerEngine.js (frontend) + routers_stickers.py (backend) are independent modules.

backend:
  - task: "Sticker Templates CRUD + duplicate"
    implemented: true
    working: true
    file: "backend/models.py, backend/routers_stickers.py, backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
        - working: "NA"
          agent: "main"
          comment: |
            New StickerTemplate model + collection. Endpoints:
              GET    /api/sticker-templates           (q, sticker_type, active filters)
              POST   /api/sticker-templates           (super_admin / hub_accountant / warehouse_manager)
              GET    /api/sticker-templates/{id}
              PUT    /api/sticker-templates/{id}
              DELETE /api/sticker-templates/{id}      (soft delete → active=false; super_admin only)
              POST   /api/sticker-templates/{id}/duplicate  (Save As)
            Smoke-tested via curl: create, list, duplicate, soft-delete all OK.
        - working: true
          agent: "testing"
          comment: |
            ✅ ALL TESTS PASSED (10/10):
            A1: Create template as super_admin - verified id, sticker_type, dpi=203, canvas_json structure, active=true
            A2a-c: Role-based access - hub_accountant ✅, warehouse_manager ✅, franchise_manager 403 ✅
            A3: List templates includes created template ✅
            A4: Filter by sticker_type=small_product ✅
            A5: Filter by name query (case-insensitive) ✅
            A6: Update template name and updated_at timestamp ✅
            A7: Duplicate returns new id with "(copy)" suffix ✅
            A8a: Soft delete (active=false) ✅
            A8b: hub_accountant cannot delete (403) ✅

  - task: "Sticker preview-data binding endpoint"
    implemented: true
    working: true
    file: "backend/routers_stickers.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
        - working: "NA"
          agent: "main"
          comment: |
            GET /api/sticker-templates/preview-data?product_id= (optional)
            Returns the bag of variables a designer/batch-print page binds {{placeholders}} against:
            sku, name, brand, category, hsn, vehicle_compatibility, mrp, selling_price,
            franchise_price, landing_price, batch_number, mfg_date, exp_date, quantity,
            barcode_value, qr_value, company_name/address/gstin, dealer_name, today, etc.
            Without product_id → safe sample values so the designer canvas always renders.
            Route MUST be declared before /sticker-templates/{tid} (path-conflict fix already applied).
        - working: true
          agent: "testing"
          comment: |
            ✅ ALL TESTS PASSED (3/3):
            B1: Preview-data without product_id returns all 17 required keys with sample values (sku=SAMPLE-001) ✅
            B2: Preview-data with real product_id returns actual product data (SKU matches) ✅
            B3: Preview-data with random UUID returns 404 ✅
            CRITICAL: No path-conflict bug - /preview-data route correctly returns 200, not "Template not found"

  - task: "Sticker Print Jobs audit log endpoints"
    implemented: true
    working: true
    file: "backend/routers_stickers.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
        - working: "NA"
          agent: "main"
          comment: |
            POST /api/sticker-print-jobs (any auth user) — records template_id, qty_strategy,
            output_format (html|pdf|zpl|epl), printer_label, product_ids, total_stickers,
            user info, ip. Used by the Batch Print page on every Print / PDF action.
            GET /api/sticker-print-jobs?template_id=&limit= — list with newest first.
            GET /api/sticker-print-jobs/{jid}/reprint-payload — fetch template + job for reprint.
            Audit log written via existing audit_logs collection.
        - working: true
          agent: "testing"
          comment: |
            ✅ ALL TESTS PASSED (6/6):
            C1: Create print job as warehouse_manager - verified id, product_count=2, total_stickers=2, user_id, user_name, ip_address, created_at ✅
            C2: franchise_manager can create print job (no role restriction) ✅
            C3: Non-existent template_id returns 404 ✅
            C4: List print jobs returns newest-first ✅
            C5: Filter by template_id works correctly ✅
            C6: Reprint payload returns {job, template} ✅

frontend:
  - task: "Sticker module routes + sidebar entry"
    implemented: true
    working: "NA"
    file: "frontend/src/App.js, frontend/src/components/Layout.jsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
        - working: "NA"
          agent: "main"
          comment: |
            Three new routes: /stickers (gallery + history), /stickers/designer/:id?,
            /stickers/batch-print. Layout sidebar gets a 'Sticker Printing' entry
            (Tag icon, visible to super_admin/hub_accountant/warehouse_manager).

  - task: "Sticker engine helper library (bwip-js + interpolation + canvas hydration)"
    implemented: true
    working: "NA"
    file: "frontend/src/lib/stickerEngine.js"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
        - working: "NA"
          agent: "main"
          comment: |
            Centralised module: interpolate({{key}}), generateBarcodeDataURL via bwip-js,
            bindCanvasJson (walks a fabric JSON, substitutes text + regenerates barcode/QR
            images), mmToPx helpers, STICKER_FIELDS palette config, loadPreviewData.
            Supports formats: code128, ean13, ean8, upca, upce, qr, datamatrix, pdf417, code39.

  - task: "Sticker Designer (fabric.js v6 Canva-style editor)"
    implemented: true
    working: "NA"
    file: "frontend/src/pages/StickerDesigner.jsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
        - working: "NA"
          agent: "main"
          comment: |
            Single-page editor:
            • Left palette: Add Text / Barcode / QR / Rect / Image, plus per-field buttons
              for every key in STICKER_FIELDS.
            • Canvas: grid background, zoom (50%-800%), snap-to-integer-px on move,
              undo/redo (60-deep), preview toggle (re-binds data live).
            • Inspector: type, X/Y/rotation, text content/size/bold/align/color, barcode
              format selector, value-key binding selector. Layer panel lists every object.
            • Save / Save As / Export Sample PDF (jsPDF at exact mm dimensions).
            Manual smoke test: created a 60×40mm template, added SKU + Name text fields
            + Code128 barcode → all rendered, save round-trip OK. Screenshot captured.

  - task: "Sticker Gallery + Print History page"
    implemented: true
    working: "NA"
    file: "frontend/src/pages/Stickers.jsx"
    stuck_count: 0
    priority: "medium"
    needs_retesting: true
    status_history:
        - working: "NA"
          agent: "main"
          comment: |
            Two-tab page: Templates (card grid with type/dims/object-count + Edit/Duplicate/Print/Delete actions)
            and Print History (audit log table: when / template / user / strategy / output / counts / printer).
            'New Template' dialog → POST /sticker-templates then redirect to designer.

  - task: "Sticker Batch Print page"
    implemented: true
    working: "NA"
    file: "frontend/src/pages/StickerBatchPrint.jsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
        - working: "NA"
          agent: "main"
          comment: |
            • Template + qty-strategy + page-layout + printer-label selectors.
            • Product picker with live SKU/name search; per-row qty for custom strategy.
            • Generate → renders each sticker through bindCanvasJson() into a hidden
              fabric.StaticCanvas, then lays them out either as A4 grid (auto cols/rows
              by template mm) or one-sticker-per-page for thermal labels.
            • Print uses window.print() with a media-query @page rule sized to the
              chosen layout — works with any printer driver.
            • PDF export uses jsPDF at exact mm.
            • Each Print/PDF call POSTs /sticker-print-jobs (audit).

metadata:
  created_by: "main_agent"
  version: "2.5"
  test_sequence: 5
  run_ui: false

test_plan:
  current_focus: []
  stuck_tasks: []
  test_all: false
  test_priority: "high_first"
  run_ui: false

agent_communication:
    - agent: "main"
      message: |
        Phase 2 backend implemented — independent Sticker / Label module under
        /api/sticker-templates and /api/sticker-print-jobs. Existing 142 backend
        tests still pass. Please run the focused test plan against the new endpoints.
    - agent: "testing"
      message: |
        ✅ V2.5 Phase 2 Sticker/Label Module Backend Testing COMPLETE - ALL TESTS PASSED (21/21)
        
        BACKEND ENDPOINTS VERIFIED:
        ✅ Template CRUD (10 tests) - Create, List, Filter, Update, Duplicate, Soft Delete, Role-based access
        ✅ Preview-data binding (3 tests) - Sample data, Real product data, 404 handling, No path-conflict bug
        ✅ Print Jobs audit log (6 tests) - Create, List, Filter, Reprint payload, Role access
        ✅ Existing pytest suite (2 tests) - 142 tests still passing
        
        CRITICAL VERIFICATIONS:
        • Default values: dpi=203, canvas_json={"version":"6","objects":[]}, active=true ✅
        • Role restrictions: super_admin/hub_accountant/warehouse_manager can create/update, only super_admin can delete ✅
        • Preview-data route declared BEFORE {tid} route - no path conflict ✅
        • All 17 required preview-data keys present with sample values ✅
        • Print jobs accept any authenticated user (no role restriction) ✅
        • Soft delete preserves doc with active=false ✅
        • Newest-first sorting on print jobs list ✅
        
        NO ISSUES FOUND. Backend implementation is production-ready.

        AUTH:
          super_admin       → admin@servall.com     / Admin@123
          hub_accountant    → accountant@servall.com / Accountant@123
          warehouse_manager → warehouse@servall.com  / Warehouse@123
          franchise_manager → franchise@servall.com  / Franchise@123

        Key verifications:
        1. POST /api/sticker-templates (admin) returns a template doc with id, default
           canvas_json={version:"6", objects:[]}, dpi=203 default. As franchise_manager
           → 403.
        2. GET /api/sticker-templates lists active templates; ?active=false returns
           soft-deleted ones too; ?q=... case-insensitive name regex; ?sticker_type=...
           filters by enum.
        3. PUT /api/sticker-templates/{id} updates name, dimensions, canvas_json. Bumps
           updated_at. Save-As via POST /sticker-templates/{id}/duplicate returns a new
           id with name suffix "(copy)".
        4. DELETE /sticker-templates/{id} only by super_admin → soft delete (active=false).
           Non-super_admin → 403.
        5. GET /api/sticker-templates/preview-data (no product) returns all 20+ field
           keys with safe sample values. With ?product_id=... overrides sku/name/mrp/etc.
           This route MUST not collide with /sticker-templates/{id} (verify GET /preview-data
           returns 200 and not "Template not found").
        6. POST /api/sticker-print-jobs records {template_id, qty_strategy, output_format,
           product_ids, total_stickers, printer_label, notes} — returns a job doc with
           id, product_count, created_at, user_id/user_name/ip_address. Listed by GET
           with newest-first sort. ?template_id filter works.
        7. GET /sticker-print-jobs/{jid}/reprint-payload returns {job, template} for a
           known job.
        8. /api/sticker-print-jobs accepts any authenticated user (warehouse/accountant/
           franchise_manager all allowed) — print history isn't restricted by role.
        9. Existing 142-test pytest suite must still be 142 passed:
           `cd /app/backend && MONGO_URL=mongodb://localhost:27017 DB_NAME=servall_erp_test python3 -m pytest tests/ -x -q`
