# PRD — Servall ERP · V2.5 Phase 2 — Sticker / Label Module

## Original Problem Statement
V2.5 Phase 2 — Sticker / Label Module (independent of inventory) for Servall ERP.
Features F7–F15 from the user spec:
- F7  — Left-nav "Sticker Printing" module.
- F8  — fabric.js drag/resize/rotate designer (grid, zoom, undo/redo, layers, align, duplicate, preview, print).
- F9  — Auto product data binding via {{placeholders}} resolved against /sticker-templates/preview-data.
- F10 — Batch printing with strategies: 1 per product / inventory_qty / custom.
- F11 — Printer-agnostic architecture (window.print + PDF export now; ZPL/EPL deferred).
- F12 — Template library (CRUD + Save As / duplicate / soft delete).
- F13 — Barcode + QR via bwip-js (Code128, EAN13, EAN8, UPC-A, UPC-E, Code39, QR).
- F14 — Print history audit log (sticker_print_jobs collection).
- F15 — Reusable engine: stickerEngine.js (frontend) + routers_stickers.py (backend) as independent modules.

User's final ask in this session: **"testing is remaining so you just have to test"** — frontend E2E only.

## Architecture
- Backend: FastAPI + MongoDB (motor). New router `routers_stickers.py` mounted at `/api/sticker-templates` and `/api/sticker-print-jobs`. Audit logging via existing `audit_logs` collection.
- Frontend: React 19 + react-router + shadcn/ui. Pages `Stickers.jsx`, `StickerDesigner.jsx`, `StickerBatchPrint.jsx`. Shared engine `lib/stickerEngine.js` wraps fabric.js v6, bwip-js, jsPDF.
- Auth: JWT (existing) with roles super_admin / hub_accountant / warehouse_manager / franchise_manager.

## User Personas
- super_admin — full access; only role that can soft-delete templates.
- hub_accountant — create/update templates, print, view history.
- warehouse_manager — create/update templates, print, view history.
- franchise_manager — print + view history only (no template CRUD).

## Core Requirements (static)
- Templates store fabric `canvas_json` (version 6), width_mm, height_mm, dpi (default 203), sticker_type, active flag.
- `preview-data` route must be declared before `/{tid}` to avoid path-conflict.
- Print job records: template_id, qty_strategy, output_format (html|pdf|zpl|epl), printer_label, product_ids, total_stickers, user_id/user_name, ip_address, created_at.
- Batch print supports A4 grid (auto cols/rows based on template mm) AND one-sticker-per-page (thermal labels) via `@page` media query.
- Audit log is immutable (templates are deletable; print-job rows are not).

## What's Been Implemented (as of 27-Jun-2026)
**Backend** (21/21 tests passing):
- ✅ Sticker Templates CRUD + duplicate (`/api/sticker-templates`)
- ✅ Preview-data binding endpoint (`/api/sticker-templates/preview-data`)
- ✅ Print Jobs audit log endpoints (`/api/sticker-print-jobs` + `/{jid}/reprint-payload`)
- ✅ Role-based access controls
- ✅ Soft-delete via active flag
- ✅ Existing 142-test pytest suite untouched and passing

**Frontend** (T1–T9 + CLEANUP all passing, 100%):
- ✅ Sidebar entry + 3 routes (`/stickers`, `/stickers/designer/:id?`, `/stickers/batch-print`)
- ✅ stickerEngine.js (bwip-js + interpolation + canvas hydration)
- ✅ Sticker Designer with fabric.js v6 (undo/redo, preview, layers, inspector, save, PDF export)
- ✅ Sticker Gallery + Print History tabs
- ✅ Batch Print page (template + strategy + product picker + generate + PDF + window.print + audit POST)

## Prioritized Backlog
**P2 (UX polish — non-blocking, called out by testing agent):**
- Stagger default Y position when palette adds a new field/text/barcode (e.g., last_added_y + 20) so they don't all stack at (20,20).
- Unify PDF filename prefix between designer-preview (`<template>-preview.pdf`) and batch-print (`stickers-<template>.pdf`).
- Align spec testid names with code: add-text-btn vs add-text, save-template-btn vs save-btn, preview-toggle vs preview-btn, bp-qty-{productId} vs bp-qty-{sku}, print-history-table vs job-{id} rows. Either rename code or update spec docs.

**P1 (deferred from F11):**
- ZPL/EPL native printer output (currently HTML+PDF only).

**P0:** None. Module is production-ready.

## Test Credentials
See `/app/memory/test_credentials.md`.

## Last Action (27-Jun-2026)
Codebase restored from GitHub `desisocrates108-ai/store.inventory` (workspace had only starter kit).
Backend + frontend services restarted, seed data loaded. Testing agent ran full frontend E2E:
T1–T9 + CLEANUP all PASS, 0 console errors, 0 5xx, audit-log delta verified.

## Next Action Items
1. (Optional) Address the three P2 UX polish items above.
2. (When ready) Begin Phase 3 — ZPL/EPL printer output (F11 follow-up).
