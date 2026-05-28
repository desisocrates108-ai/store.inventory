# Servall Nexus ERP — PRD

## Original Problem
Build a Next-Gen B2B Franchise ERP for Servall — a multi-branch two-wheeler automotive spare parts distribution network operating on a Hub-and-Spoke model. Replace Vyapar with a custom, premium, scalable ERP. Aesthetics: Apple-minimal + Notion-clean + Zoho-robust.

## User Choices
- Scope: All major modules in v1.
- AI/OCR: Gemini 3 Flash multimodal (`gemini-3-flash-preview`) via Emergent Universal Key.
- Auth: JWT-based with 4 roles (super_admin, hub_accountant, warehouse_manager, franchise_manager).
- Demo data seeded on first startup (idempotent).
- Language: User prefers Hinglish (Hindi + English) responses.

## Architecture
- Backend: FastAPI + Motor (MongoDB), Pydantic v2, PyJWT + bcrypt, emergentintegrations for Gemini OCR.
- Frontend: React 19 + Tailwind + Shadcn UI + Recharts + Phosphor Icons + sonner toasts.
- DB collections: users, franchises, vendors, products, stock, stock_movements, invoices, purchase_orders, indents, delivery_challans, cycle_counts, audit_logs, notifications, counters.

## User Personas
1. **Super Admin**: Global financial metrics, margin control, user/franchise mgmt, audit logs.
2. **Hub Accountant**: Vendor payments, invoicing, GST, audit logs.
3. **Warehouse Manager**: Inward/outward stock, dispatch, cycle counts, POs, fulfillment.
4. **Franchise Manager**: Raises indents, tracks pipeline. Cannot see hub stock numbers.

## Implemented (May 2026)
- JWT auth (login, /auth/me, role guards), bcrypt, 4 demo accounts seeded.
- Unified inventory with multi-tier stock (hub + per-franchise), search, filters, low-stock indicator.
- Product CRUD, manual stock adjust, bulk margin update across category/all.
- AI OCR invoice ingestion (drag-drop PDF/JPG/PNG → Gemini 3 Flash → reconciliation view → commit), anomaly detection, duplicate invoice check, commits to hub stock + recalculates pricing.
- Vendor management with credit days, outstanding balance, rating, fulfillment score.
- Franchise management with GSTIN, credit limit.
- **Advanced Franchise Indent + Warehouse Fulfillment Workflow (May 28, 2026):**
  - New statuses: `pending → partially_fulfilled / awaiting_stock → fulfilled → dispatched → delivered` (+ `rejected` / `cancelled`).
  - `POST /api/indents/{id}/fulfill` — per-line `fulfill_qty` allocation, partial fulfillment supported, hub stock decremented immediately, every change logged as immutable `StockMovement` (qty_before / qty_after / delta / reference_id).
  - `POST /api/indents/{id}/reject` — with reason, notifies franchise, audit-logged.
  - `GET /api/indents/pending-stock/summary` — backorder dashboard showing pending qty vs hub availability per item.
  - `GET /api/stock-movements` — full audit trail, filter by product/reference. Forbidden (403) for franchise.
  - Frontend Smart Fulfillment Modal: live hub-stock decrement, per-line qty input bounded by `min(pending, available)`, one-click "Auto-fill Max Available", insufficient-stock visual cues.
  - Reject Dialog with reason textarea.
  - 6-column Kanban for warehouse: Pending Review / Partially Allocated / Awaiting Stock / Ready to Dispatch / Dispatched / Delivered.
  - Franchise UI: simple card grid (no Kanban), no hub-stock leakage.
- **Franchise Confidentiality (May 28, 2026):**
  - `/api/products` whitelists `FRANCHISE_SAFE_KEYS` for franchise_manager (no hub_stock, landing_price, margin_percent, safety_stock, primary_vendor_id).
  - `/api/dashboard/stats` returns reduced `is_franchise:true` payload (only my_pending/my_fulfilled/my_dispatched/my_delivered/trend_7d/total_indents).
  - `/api/indents` auto-scopes to user's franchise_id.
  - Frontend Dashboard branches on `stats.is_franchise` → "My Franchise" view with own pipeline KPIs only.
- Delivery challans + auto tax invoice with CGST/SGST/IGST, transporter + E-Way bill fields, verification QR.
- Purchase Orders: auto-generate from low stock grouped by primary vendor, status flow.
- Inventory Aging matrix (0-30 / 31-90 / 91-180 / 181-365 / 365+) with chart and items table.
- Blind cycle counting (random batch generator, variance, auto-adjust).
- Dynamic pricing engine with global/category margin update.
- Immutable audit logs (all key actions).
- Dashboard with live KPIs, 7-day trend, top-moving products, dead stock card (admin/warehouse only).
- RBAC enforced at route level via `require_roles`.
- Light + true-black dark mode toggle, global Cmd-K style search bar, mobile-responsive sidebar.

## Test Coverage
- `/app/backend/tests/test_fulfillment_workflow.py` — 19 tests (partial/full fulfill chain, validation, reject, stock-movements immutability, RBAC masking) — ALL PASSING.
- `/app/backend/tests/test_servall_backend.py` — lifecycle tests updated for new fulfill endpoint — 7 PASSING.

## Backlog
**P1** — Next priorities
- Auto-reopen pending indents when restock PO is received (notify warehouse, lift "awaiting_stock" indents).
- FIFO batch-wise allocation in fulfillment.
- Barcode-based dispatch verification (mobile/tablet friendly).
- Convert N+1 stock lookups in `/api/products` and `/api/dashboard/stats` to MongoDB `$lookup`.
- Refactor server.py (~1240 lines) into routers (/app/backend/routes/auth.py, indents.py, inventory.py, etc.).

**P2** — Advanced
- WhatsApp / Email low-stock alerts.
- Vendor Credit Health widget (working capital optimizer).
- Demand forecasting AI (consumption seasonality).
- Vendor rate variance recommendations on PO drafts.
- E-Way Bill API integration (GSTN).
- Excel/PDF exports.
- Stock-Movements audit page UI (admin/warehouse).

## Notes
- "Made with Emergent" badge is platform branding; cannot be removed by agent. User must contact support.
