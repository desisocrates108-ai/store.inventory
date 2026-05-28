# Servall Nexus ERP — PRD

## Original Problem
Build a Next-Gen B2B Franchise ERP for Servall — a multi-branch two-wheeler automotive spare parts distribution network operating on a Hub-and-Spoke model. Replace Vyapar with a custom, premium, scalable ERP. Aesthetics: Apple-minimal + Notion-clean + Zoho-robust.

## User Choices
- Scope: All major modules in v1.
- AI/OCR: Gemini 3 Flash multimodal (`gemini-3-flash-preview`) via Emergent Universal Key.
- Auth: JWT-based with 4 roles (super_admin, hub_accountant, warehouse_manager, franchise_manager).
- Demo data seeded on first startup (idempotent).
- Design: handled by design agent — clean white/charcoal + true-black dark mode, Outfit/Manrope/JetBrains Mono fonts, Phosphor icons.

## Architecture
- Backend: FastAPI + Motor (MongoDB), Pydantic v2, PyJWT + bcrypt, emergentintegrations for Gemini OCR.
- Frontend: React 19 + Tailwind + Shadcn UI + Recharts + Phosphor Icons + sonner toasts.
- DB collections: users, franchises, vendors, products, stock, invoices, purchase_orders, indents, delivery_challans, cycle_counts, audit_logs, notifications, counters.

## User Personas
1. **Super Admin** (CEO/Core mgmt): Global financial metrics, margin control, user/franchise mgmt, audit logs.
2. **Hub Accountant**: Vendor payments, invoicing, GST, audit logs.
3. **Warehouse Manager**: Inward/outward stock, dispatch, cycle counts, POs.
4. **Franchise Manager**: Raises indents for their own franchise, views local stock.

## Implemented (May 2026)
- JWT auth (login, /auth/me, role guards), bcrypt, 4 demo accounts seeded.
- Unified inventory with multi-tier stock (hub + per-franchise), search, filters, low-stock indicator.
- Product CRUD, manual stock adjust, bulk margin update across category/all.
- AI OCR invoice ingestion (drag-drop PDF/JPG/PNG → Gemini 3 Flash → reconciliation view → commit), anomaly detection (price change %, new item), duplicate invoice check, commits to hub stock + recalculates pricing.
- Vendor management with credit days, outstanding balance, rating, fulfillment score.
- Franchise management with GSTIN, credit limit.
- Indents Kanban (Requested → Approved → Dispatched → Delivered), Urgent/Routine priority, partial fulfillment ratio, auto-backorder split, dispatch generates DC, deliver generates invoice.
- Delivery challans + auto tax invoice with CGST/SGST/IGST, transporter + E-Way bill fields, verification QR.
- Purchase Orders: auto-generate from low stock grouped by primary vendor, status flow.
- Inventory Aging matrix (0-30 / 31-90 / 91-180 / 181-365 / 365+) with chart and items table.
- Blind cycle counting (random batch generator, variance, auto-adjust).
- Dynamic pricing engine with global/category margin update.
- Immutable audit logs (all key actions: product create/update, stock adjust, indent lifecycle, invoice commit, vendor change, etc.).
- Dashboard with live KPIs, 7-day trend, top-moving products, dead stock card.
- RBAC enforced at route level via `require_roles`.
- Light + true-black dark mode toggle, global Cmd-K style search bar, mobile-responsive sidebar.

## Backlog (P0/P1/P2)
**P1** — Optimization & polish
- Convert N+1 stock lookups in `/api/products` and `/api/dashboard/stats` to MongoDB `$lookup` aggregations.
- Vendor ledger view (payments-in / payments-out timeline + due reminders).
- Indent detail dialog (currently summary on Kanban card only).
- Mobile camera barcode scanner page (PWA).
- WhatsApp/email notifications channel (currently only in-app).

**P2** — Advanced AI
- Predictive demand forecasting (consumption seasonality charts).
- Abnormal franchise consumption alerts.
- Vendor rate variance recommendations on PO drafts.
- E-Way Bill API integration (GSTN).
- Excel/PDF exports across reports.
- Cycle count discrepancy adjustment ledger entry.

## Next Tasks
1. Vendor ledger + payment-out flow.
2. Indent detail view with full line-item breakdown.
3. Mobile barcode-scan inventory lookup.
4. WhatsApp Business API integration for low-stock & dispatch alerts.
