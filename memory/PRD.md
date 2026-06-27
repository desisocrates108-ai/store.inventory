# PRD — Servall ERP

## Latest Module (V2.6 — E-Way Bill, added 2026-06-27)

### Original Problem Statement
"NEW FEATURE — COMPLETE E-WAY BILL MODULE (Enterprise Grade)" — fully integrated
E-Way Bill module (not just a PDF). Must auto-fill from a linked Tax Invoice or
Delivery Challan, support sequential numbering (`EWB-YYYY-000001`), generate a
government-style PDF with QR + Code128 barcode, expose a search/filter screen,
enforce role-based access, and be designed for future NIC E-Way Bill API
integration without rewriting.

### Architecture
- **Backend collection**: `eway_bills`. Pydantic `EWayBill` model lives in
  `backend/models.py` with `EWayBillPartyBlock` + `EWayBillLineItem` snapshot
  sub-models so source-doc edits never silently mutate an active EWB.
- **Router**: `backend/routers_eway_bills.py` — mounted at `/api/eway-bills`.
- **Provider abstraction**: `EWB_PROVIDER` env var (default `LOCAL`). Two
  injection points — `generate_number()` and `push_to_provider()` — are the
  only edits required to wire the official NIC API later.
- **Numbering**: counters collection `eway_bill_{year}` → `EWB-YYYY-000001`.
- **Validity**: 1 day per 200 km, minimum 1 day.
- **PDF**: ReportLab — 5 sections (EWB Meta, FROM, TO, Goods, Transport) + a
  footer with QR (encodes EBN+invoice+supplier GSTIN+recipient GSTIN+vehicle+date)
  and a Code128 barcode of the EBN. Auto-switches between CGST/SGST and IGST
  columns based on the source totals.
- **Backlinks**: when an EWB is created, `tax_invoices.eway_bill_id` /
  `delivery_challans.eway_bill_id` are updated so the source doc's UI can show
  "View E-Way Bill (EBN)" instead of "Generate".

### Endpoints
| Method | Path                                            | Roles                                                 |
|-------:|-------------------------------------------------|-------------------------------------------------------|
| GET    | `/api/eway-bills`                               | all (franchise sees only own)                         |
| POST   | `/api/eway-bills/from-invoice/{tid}`            | super_admin / warehouse_manager / hub_accountant       |
| POST   | `/api/eway-bills/from-challan/{dcid}`           | super_admin / warehouse_manager / hub_accountant       |
| GET    | `/api/eway-bills/{eid}`                         | all (franchise scoping)                                |
| PUT    | `/api/eway-bills/{eid}`                         | super_admin / warehouse_manager / hub_accountant       |
| POST   | `/api/eway-bills/{eid}/cancel`                  | super_admin / hub_accountant                           |
| POST   | `/api/eway-bills/{eid}/duplicate`               | super_admin / warehouse_manager / hub_accountant       |
| GET    | `/api/eway-bills/{eid}/pdf`                     | all (franchise scoping)                                |
| GET    | `/api/eway-bills/by-invoice/{tid}`              | all                                                   |
| GET    | `/api/eway-bills/by-challan/{dcid}`             | all                                                   |

### Frontend
- **Sidebar**: new `E-Way Bills` entry (Truck icon) under the existing
  invoicing section. Visible to all roles; the API enforces scope.
- **Page** `/eway-bills` — `EWayBills.jsx` — filterable list (search, vehicle,
  transporter, status, date range) with per-row Download / Print / Duplicate /
  Cancel actions (Duplicate + Cancel hidden for franchise users).
- **Reusable dialog** `EWayBillDialog.jsx` — used from `EWayBills.jsx`,
  `TaxInvoiceDetail.jsx`, and the DC detail dialog. Auto-fills the snapshot
  (supplier, recipient, items, totals) and only lets the user edit transport
  details (vehicle, transporter, GSTIN/ID, LR, distance, mode, reason,
  remarks). Save / Save & Regenerate / Download / Close in the footer.
- **Tax Invoice page** — adds `Generate E-Way Bill` button on
  issued/paid/non-cancelled invoices; flips to `View E-Way Bill (EBN)` once one
  exists.
- **Delivery Challan dialog** — same generate/view button at the bottom.

### Test Status (iteration_7)
- **Backend**: 11/11 pytest cases pass (`/app/backend/tests/test_eway_bills.py`).
- **Frontend**: 100 % of exercised flows pass. F4 was partially blocked by the
  seed having only a draft tax invoice; addressed below.

### Post-test fixes (idempotent seed top-up)
1. `seed.py` now upserts `org_settings` with GSTIN
   `29AAACS9999A1Z5`, state_code `29`, pincode `560022`, etc., so newly created
   DC-sourced EWBs include the supplier GSTIN. New EWB `EWB-2026-000035`
   verified to carry the supplier GSTIN on the snapshot.
2. The single seeded tax invoice (`TI/2026-27/0001`) is now issued
   (status=`issued`) so the F4 `generate-ewb-btn` path is exercisable end-to-end.

### Backlog (deferred enhancements from test_report critical_code_review)
- P3 — collapse `update_eway_bill()` two-step write into a single `$set`.
- P3 — split `_render_eway_bill_pdf()` into its own `eway_bill_pdf.py` module
  for readability (file is currently ~895 lines).
- P3 — decide policy on duplicate's parent backlink (currently duplicate keeps
  the original EWB as the active backlink on the source doc; could be flipped
  to point at the newest active EWB).
- P2 — when EWB_PROVIDER is flipped to `NIC_API`, wire the real submission +
  status polling inside `generate_number()` + `push_to_provider()`.

## Earlier modules
- **V2.5 P2 Sticker / Label Module** — complete and verified (T1–T9 + cleanup,
  100 % pass). See sticker section in `test_result.md`.

## Test Credentials
See `/app/memory/test_credentials.md`.
