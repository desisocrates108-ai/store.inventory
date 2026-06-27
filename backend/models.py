"""Pydantic models for Servall ERP."""
from datetime import datetime, timezone
from typing import Optional, List, Literal
from pydantic import BaseModel, Field, EmailStr, ConfigDict
import uuid


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def gen_id() -> str:
    return str(uuid.uuid4())


# ============ USERS ============
Role = Literal["super_admin", "hub_accountant", "warehouse_manager", "franchise_manager"]


class UserBase(BaseModel):
    model_config = ConfigDict(extra="ignore")
    email: EmailStr
    full_name: str
    role: Role
    franchise_id: Optional[str] = None  # required if role==franchise_manager
    active: bool = True


class UserCreate(UserBase):
    password: str


class User(UserBase):
    id: str = Field(default_factory=gen_id)
    created_at: str = Field(default_factory=now_iso)


class UserPublic(UserBase):
    id: str
    created_at: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class LoginResponse(BaseModel):
    token: str
    user: UserPublic


# ============ FRANCHISES ============
class Franchise(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=gen_id)
    code: str  # e.g. FR-DEL-001
    name: str
    city: str
    state: str
    address: str = ""
    gstin: str = ""
    contact_phone: str = ""
    contact_email: str = ""
    credit_limit: float = 0.0
    active: bool = True
    tier_id: Optional[str] = None  # V2.1 — franchise pricing tier
    # V2.4 — versioned Starter-Kit snapshot captured from the assigned tier.
    # Once captured, edits to the source tier do NOT mutate this; admin can edit
    # the franchise's own snapshot freely without affecting other franchises.
    starter_kit: Optional["FranchiseStarterKitSnapshot"] = None
    created_at: str = Field(default_factory=now_iso)


# ============ FRANCHISE TIERS (V2.1) ============
class CategoryMarginOverride(BaseModel):
    """Optional per-category margin override inside a tier."""
    category: str
    margin_percent: float


class StarterKitItem(BaseModel):
    """A product + per-item pricing in a tier's Starter-Kit template.

    Pricing is fully per-item: discount_percent and margin_percent override
    the tier defaults for THIS line only. If margin_percent is None the
    tier-level default_margin_percent is used as a fallback at render time.
    Discount is ALWAYS per-item — no global discount concept any more.
    """
    model_config = ConfigDict(extra="ignore")
    product_id: str
    sku: str = ""
    name: str = ""
    recommended_qty: float = 1.0
    discount_percent: float = 0.0
    margin_percent: Optional[float] = None  # None → fall back to tier.margin_percent


class FranchiseStarterKitSnapshot(BaseModel):
    """Immutable point-in-time copy of a tier's Starter-Kit attached to a
    franchise. Subsequent edits to the source tier never mutate this snapshot
    — that is the whole point of versioning."""
    model_config = ConfigDict(extra="ignore")
    tier_id: Optional[str] = None
    tier_name: str = ""
    default_margin_percent: float = 22.0
    items: List[StarterKitItem] = []
    captured_at: str = Field(default_factory=now_iso)
    version: int = 1  # bumped each time admin replaces the snapshot


class FranchiseTier(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=gen_id)
    name: str  # MASTER / STANDARD / BUDDY / PERFORMAX / custom
    margin_percent: float = 22.0  # default margin applied if no category override
    default_discount_percent: float = 0.0  # legacy global discount — kept for back-compat; per-item discount on starter_kit_items is the new source of truth
    category_overrides: List[CategoryMarginOverride] = []
    starter_kit_items: List[StarterKitItem] = []
    color: str = ""  # hex e.g. "#10b981" — for UI badges
    is_system: bool = False  # if true, cannot be deleted
    active: bool = True
    created_at: str = Field(default_factory=now_iso)


# ============ VENDORS ============
class Vendor(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=gen_id)
    code: str
    name: str
    gstin: str = ""
    address: str = ""
    contact_phone: str = ""
    contact_email: str = ""
    credit_period_days: int = 30
    outstanding_balance: float = 0.0
    credit_limit: float = 0.0
    rating: float = 4.5  # 0..5
    fulfillment_score: float = 95.0  # 0..100 %
    created_at: str = Field(default_factory=now_iso)


# ============ PRODUCTS / SKU ============
class Product(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=gen_id)
    sku: str
    name: str
    brand: str = ""
    category: str = ""
    subcategory: str = ""
    part_number_oem: str = ""
    part_number_aftermarket: str = ""
    hsn_code: str = ""
    barcode: str = ""
    qr_code: str = ""
    unit: str = "pcs"  # pcs / box / set / ltr
    pack_size: int = 1
    rack_location: str = ""  # e.g. "Rack A - Shelf 3 - Bin 12"
    # pricing
    landing_price: float = 0.0  # purchase + tax + freight
    mrp: float = 0.0
    franchise_price: float = 0.0
    retail_price: float = 0.0
    gst_rate: float = 18.0
    margin_percent: float = 20.0
    # stock thresholds
    safety_stock: int = 10
    reorder_qty: int = 50
    # batch
    has_expiry: bool = False
    image_url: str = ""
    primary_vendor_id: Optional[str] = None
    active: bool = True
    created_at: str = Field(default_factory=now_iso)


# ============ STOCK (per location) ============
LocationType = Literal["hub", "franchise"]


class StockItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=gen_id)
    product_id: str
    location_type: LocationType
    location_id: str  # hub_id or franchise_id
    quantity: int = 0
    batch_no: str = ""
    expiry_date: Optional[str] = None
    last_in_date: Optional[str] = None  # iso
    last_out_date: Optional[str] = None
    updated_at: str = Field(default_factory=now_iso)


# ============ INVOICES (purchase) ============
class InvoiceLineItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    product_id: Optional[str] = None  # null if unmatched
    product_name: str
    sku: str = ""
    hsn_code: str = ""
    quantity: float
    unit_price: float
    gst_percent: float = 18.0
    line_total: float
    matched: bool = True
    anomaly: Optional[str] = None  # e.g., "price_increased_15%"
    # V2.1 OCR extras (all optional, back-compat safe)
    item_alias: str = ""
    unit: str = ""
    cgst_percent: float = 0.0
    sgst_percent: float = 0.0
    net_amount: float = 0.0
    qty_valid: bool = True
    hsn_valid: bool = True
    desc_valid: bool = True
    unit_valid: bool = True
    row_valid: bool = True
    confidence: float = 1.0
    # V2.2 OCR — confidence split + alias match metadata
    llm_confidence: float = 1.0          # LLM self-reported (0..1)
    heuristic_confidence: float = 1.0    # rule-based score (0..1)
    auto_matched_alias: bool = False     # true if matched via vendor alias engine
    match_source: Optional[str] = None   # "alias" | "sku" | "name" | None
    warnings: List[str] = []             # ["missing_hsn", "missing_qty", ...]


class PurchaseInvoice(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=gen_id)
    invoice_number: str
    vendor_id: Optional[str] = None
    vendor_name: str = ""
    invoice_date: str = ""
    total_amount: float = 0.0
    cgst: float = 0.0
    sgst: float = 0.0
    igst: float = 0.0
    line_items: List[InvoiceLineItem] = []
    file_url: str = ""  # path stored
    status: Literal["draft", "reconciled", "committed"] = "draft"
    raw_ocr_text: str = ""
    confidence_score: float = 0.0  # V2.1 — avg combined across rows
    llm_confidence: float = 0.0    # V2.2 — avg LLM self-reported
    heuristic_confidence: float = 0.0  # V2.2 — avg heuristic
    ocr_provider: str = ""
    ocr_model: str = ""
    created_by: str = ""
    created_at: str = Field(default_factory=now_iso)


# ============ OCR LEARNING ENGINE (V2.1) ============
class OcrAlias(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=gen_id)
    vendor_id: Optional[str] = None
    vendor_alias: str  # vendor's short code, e.g. "RES02", "AT24026"
    product_id: str
    sku: str
    hits: int = 1
    last_used_at: str = Field(default_factory=now_iso)
    created_at: str = Field(default_factory=now_iso)


# ============ PURCHASE ORDERS ============
class POLineItem(BaseModel):
    product_id: str
    product_name: str
    sku: str
    quantity: int
    unit_price: float
    line_total: float


class PurchaseOrder(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=gen_id)
    po_number: str
    vendor_id: str
    vendor_name: str = ""
    line_items: List[POLineItem] = []
    total_amount: float = 0.0
    status: Literal["draft", "sent", "received", "cancelled"] = "draft"
    auto_generated: bool = False
    notes: str = ""
    created_by: str = ""
    created_at: str = Field(default_factory=now_iso)


# ============ INDENTS (franchise orders) ============
IndentStatus = Literal[
    "pending",              # newly raised, awaiting warehouse review
    "partially_fulfilled",  # some lines allocated, some still pending stock
    "fulfilled",            # all lines fully allocated, ready to dispatch
    "awaiting_stock",       # zero allocated; waiting for restock
    "rejected",             # warehouse manager declined
    "dispatched",           # on the way
    "delivered",            # received & invoiced
    "cancelled",
]


class IndentLineItem(BaseModel):
    product_id: str
    product_name: str
    sku: str
    requested_qty: int
    allocated_qty: int = 0
    backorder_qty: int = 0
    unit_price: float = 0.0  # raw franchise price (pre-discount)
    discount_percent: float = 0.0          # V2.4 — per-line discount %
    margin_percent: Optional[float] = None # V2.4 — per-line margin override
    mrp: float = 0.0                       # V2.4 — for sticker / display
    selling_price: float = 0.0             # V2.4 — unit_price × (1 − discount%) (server-recomputed)
    line_total: float = 0.0                # = selling_price × requested_qty (server-recomputed)


class Indent(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=gen_id)
    indent_number: str
    franchise_id: str
    franchise_name: str = ""
    # V2.4 — extended priority set. 'new_franchise_setup' marks the first order
    # built from the franchise's Starter-Kit snapshot.
    priority: Literal["routine", "urgent", "emergency", "new_franchise_setup"] = "routine"
    status: IndentStatus = "pending"
    line_items: List[IndentLineItem] = []
    total_amount: float = 0.0
    fulfillment_ratio: float = 0.0  # 0..100
    notes: str = ""
    rejection_reason: str = ""
    created_by: str = ""
    fulfilled_by: Optional[str] = None
    created_at: str = Field(default_factory=now_iso)
    fulfilled_at: Optional[str] = None
    approved_at: Optional[str] = None
    rejected_at: Optional[str] = None
    dispatched_at: Optional[str] = None
    delivered_at: Optional[str] = None
    eta: Optional[str] = None
    # V2.1 — multi-source ordering
    source: Literal["system", "photo", "excel", "starter_kit"] = "system"
    source_attachment_url: Optional[str] = None  # /uploads/... for photo/excel
    # V2.4 — link back to the Starter-Kit snapshot that seeded this indent (audit only)
    starter_kit_snapshot_version: Optional[int] = None


# ============ DELIVERY CHALLANS / INVOICES ============
class DeliveryChallan(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=gen_id)
    dc_number: str
    indent_id: str
    franchise_id: str
    franchise_name: str = ""
    transporter_name: str = ""
    vehicle_number: str = ""
    lr_number: str = ""
    eway_bill_number: str = ""
    line_items: List[IndentLineItem] = []
    total_amount: float = 0.0
    cgst: float = 0.0
    sgst: float = 0.0
    igst: float = 0.0
    grand_total: float = 0.0
    status: Literal["draft", "dispatched", "verified", "invoiced"] = "draft"
    invoice_number: Optional[str] = None
    verification_qr: str = ""
    created_at: str = Field(default_factory=now_iso)
    verified_at: Optional[str] = None


# ============ CYCLE COUNT ============
class CycleCountItem(BaseModel):
    product_id: str
    product_name: str
    sku: str
    system_qty: int
    counted_qty: Optional[int] = None
    variance: Optional[int] = None


class CycleCount(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=gen_id)
    cc_number: str
    type: Literal["weekly", "monthly", "yearly"] = "weekly"
    location_type: LocationType = "hub"
    location_id: str = "hub-main"
    items: List[CycleCountItem] = []
    status: Literal["open", "completed"] = "open"
    notes: str = ""
    created_by: str = ""
    created_at: str = Field(default_factory=now_iso)
    completed_at: Optional[str] = None


# ============ AUDIT LOGS ============
class AuditLog(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=gen_id)
    timestamp: str = Field(default_factory=now_iso)
    user_id: str
    user_email: str = ""
    action: str  # e.g., "product.update"
    entity_type: str = ""
    entity_id: str = ""
    before: Optional[dict] = None
    after: Optional[dict] = None
    ip_address: str = ""


# ============ STOCK MOVEMENTS (immutable audit trail) ============
class StockMovement(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=gen_id)
    timestamp: str = Field(default_factory=now_iso)
    product_id: str
    sku: str = ""
    product_name: str = ""
    location_type: LocationType
    location_id: str
    location_label: str = ""
    delta: int  # +incoming / -outgoing
    qty_before: int
    qty_after: int
    reason: str = ""
    reference_type: str = ""  # e.g., "indent", "invoice", "cycle_count", "manual"
    reference_id: str = ""
    user_id: str = ""
    user_email: str = ""

class Notification(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=gen_id)
    user_id: Optional[str] = None  # null = broadcast to role
    role: Optional[Role] = None
    title: str
    body: str = ""
    level: Literal["info", "warning", "danger", "success"] = "info"
    link: str = ""
    read: bool = False
    created_at: str = Field(default_factory=now_iso)


# ============ V2.2 — SALES TAX INVOICE MODULE ============
class OrganizationSettings(BaseModel):
    """Singleton — keyed by id='org-settings'."""
    model_config = ConfigDict(extra="ignore")
    id: str = "org-settings"
    legal_name: str = "Servall Pvt Ltd"
    trade_name: str = ""
    address_line1: str = ""
    address_line2: str = ""
    city: str = ""
    state: str = ""             # name e.g. "Karnataka"
    state_code: str = ""        # 2-digit GSTIN state code e.g. "29"
    pincode: str = ""
    country: str = "India"
    gstin: str = ""
    pan: str = ""
    cin: str = ""               # corporate identity number
    phone: str = ""
    email: str = ""
    website: str = ""
    bank_name: str = ""
    bank_account: str = ""
    bank_ifsc: str = ""
    bank_branch: str = ""
    invoice_prefix: str = "TI/2026-27/"    # tax invoice prefix
    invoice_pad: int = 4
    credit_note_prefix: str = "CN-2026-"    # credit note prefix (franchise returns)
    credit_note_pad: int = 4
    debit_note_prefix: str = "DN-2026-"     # debit note prefix (vendor returns)
    debit_note_pad: int = 4
    default_terms: str = "1. Goods once sold will not be taken back.\n2. Payment due within 30 days.\n3. Interest @ 18% p.a. on overdue invoices.\n4. Subject to local jurisdiction only."
    logo_url: str = ""
    signature_url: str = ""
    auto_create_tax_invoice_on_delivery: bool = True
    updated_at: str = Field(default_factory=now_iso)


class TaxInvoiceLineItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    product_id: Optional[str] = None
    sku: str = ""
    description: str
    hsn: str = ""
    qty: float = 1.0
    unit: str = "PCS"
    unit_price: float = 0.0
    discount_percent: float = 0.0
    taxable_value: float = 0.0
    gst_percent: float = 18.0
    cgst_amount: float = 0.0
    sgst_amount: float = 0.0
    igst_amount: float = 0.0
    cess_amount: float = 0.0
    line_total: float = 0.0


TaxInvoiceStatus = Literal["draft", "issued", "paid", "cancelled"]


class TaxInvoice(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=gen_id)
    invoice_number: str = ""               # assigned on issue; blank for drafts
    invoice_date: str = Field(default_factory=lambda: now_iso()[:10])
    due_date: str = ""
    status: TaxInvoiceStatus = "draft"

    # Source linkage
    source_type: Literal["challan", "manual"] = "manual"
    challan_id: Optional[str] = None
    dc_number: Optional[str] = None
    indent_id: Optional[str] = None

    # Customer (franchise)
    franchise_id: Optional[str] = None
    franchise_code: str = ""
    franchise_name: str = ""
    billing_name: str = ""
    billing_address: str = ""
    billing_gstin: str = ""
    billing_state: str = ""
    billing_state_code: str = ""
    shipping_address: str = ""
    contact_phone: str = ""
    contact_email: str = ""

    # Place of supply (for IGST vs CGST/SGST decision)
    place_of_supply: str = ""           # e.g. "29-Karnataka"
    is_inter_state: bool = False

    # Line items + totals
    line_items: List[TaxInvoiceLineItem] = []
    subtotal: float = 0.0                # sum of taxable_value
    total_discount: float = 0.0
    cgst_total: float = 0.0
    sgst_total: float = 0.0
    igst_total: float = 0.0
    cess_total: float = 0.0
    round_off: float = 0.0
    grand_total: float = 0.0
    amount_in_words: str = ""

    # Terms / notes
    terms: str = ""
    notes: str = ""
    payment_terms: str = "Net 30"

    # Audit
    created_by: str = ""
    created_at: str = Field(default_factory=now_iso)
    issued_at: Optional[str] = None
    cancelled_at: Optional[str] = None
    cancelled_reason: str = ""
    paid_at: Optional[str] = None



# ============ RETURNS — CREDIT NOTES (Franchise returns) ============
class ReturnLineItem(BaseModel):
    """Shared line item for Credit & Debit notes."""
    model_config = ConfigDict(extra="ignore")
    product_id: Optional[str] = None
    sku: str = ""
    description: str = ""
    hsn: str = ""
    qty: float = 1.0
    unit: str = "PCS"
    unit_price: float = 0.0
    discount_percent: float = 0.0
    taxable_value: float = 0.0
    gst_percent: float = 18.0
    cgst_amount: float = 0.0
    sgst_amount: float = 0.0
    igst_amount: float = 0.0
    line_total: float = 0.0
    reason: str = ""  # damaged / wrong_item / excess / quality / other


ReturnStatus = Literal["draft", "issued", "cancelled"]


class CreditNote(BaseModel):
    """Credit Note — issued when a franchise returns products.
    On 'issue': hub stock is incremented (goods come back to hub) and an audit log + stock movements are written."""
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=gen_id)
    cn_number: str = ""                # assigned on issue
    cn_date: str = Field(default_factory=lambda: now_iso()[:10])
    status: ReturnStatus = "draft"

    # Source linkage — both modes supported
    source_type: Literal["invoice", "manual"] = "manual"
    tax_invoice_id: Optional[str] = None
    tax_invoice_number: Optional[str] = None

    # Franchise (customer who is returning)
    franchise_id: Optional[str] = None
    franchise_code: str = ""
    franchise_name: str = ""
    billing_address: str = ""
    billing_gstin: str = ""
    billing_state: str = ""
    billing_state_code: str = ""

    # Place of supply
    place_of_supply: str = ""
    is_inter_state: bool = False

    # Items + totals
    line_items: List[ReturnLineItem] = []
    subtotal: float = 0.0
    total_discount: float = 0.0
    cgst_total: float = 0.0
    sgst_total: float = 0.0
    igst_total: float = 0.0
    round_off: float = 0.0
    grand_total: float = 0.0
    amount_in_words: str = ""

    # Reason / notes
    reason: str = ""                   # overall reason
    notes: str = ""

    # Audit
    created_by: str = ""
    created_at: str = Field(default_factory=now_iso)
    issued_at: Optional[str] = None
    cancelled_at: Optional[str] = None
    cancelled_reason: str = ""


# ============ RETURNS — DEBIT NOTES (Vendor returns) ============
class DebitNote(BaseModel):
    """Debit Note — issued when we return products to a vendor.
    On 'issue': hub stock is decremented (goods leave hub) and an audit log + stock movements are written."""
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=gen_id)
    dn_number: str = ""
    dn_date: str = Field(default_factory=lambda: now_iso()[:10])
    status: ReturnStatus = "draft"

    # Source linkage
    source_type: Literal["purchase_order", "manual"] = "manual"
    po_id: Optional[str] = None
    po_number: Optional[str] = None

    # Vendor (supplier receiving the return)
    vendor_id: Optional[str] = None
    vendor_name: str = ""
    vendor_gstin: str = ""
    vendor_address: str = ""
    vendor_state: str = ""

    # Place of supply
    place_of_supply: str = ""
    is_inter_state: bool = False

    # Items + totals
    line_items: List[ReturnLineItem] = []
    subtotal: float = 0.0
    total_discount: float = 0.0
    cgst_total: float = 0.0
    sgst_total: float = 0.0
    igst_total: float = 0.0
    round_off: float = 0.0
    grand_total: float = 0.0
    amount_in_words: str = ""

    reason: str = ""
    notes: str = ""

    created_by: str = ""
    created_at: str = Field(default_factory=now_iso)
    issued_at: Optional[str] = None
    cancelled_at: Optional[str] = None
    cancelled_reason: str = ""


# ============================================================================
# V2.5 Phase-2 — Sticker / Label Module (independent of inventory)
# ============================================================================
# Design notes:
#   • A Sticker Template is just a fabric.js canvas JSON + meta. We do NOT
#     parse the canvas server-side — the front-end designer is the source of
#     truth for visuals. The server only stores blobs and serves data bindings.
#   • Variable bindings live on text/barcode/qr objects via {{key}} placeholders
#     (e.g. {{sku}}, {{name}}, {{mrp}}). When printing, the front-end resolves
#     them against /sticker-templates/{id}/preview-data?product_id=...
#   • output_format on a print job is intentionally string so future ZPL/EPL
#     emitters can be plugged in without touching the model.

StickerType = Literal[
    "small_product", "large_product", "dealer", "custom", "barcode_label", "qr_label"
]


class StickerTemplate(BaseModel):
    """A reusable sticker design persisted on the server."""
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=gen_id)
    name: str
    sticker_type: StickerType = "custom"
    description: str = ""
    # Physical dimensions in millimetres. The canvas pixel size = mm × (dpi / 25.4).
    width_mm: float = 50.0
    height_mm: float = 30.0
    dpi: int = 203                # default thermal label DPI; A4 use ~96
    background_color: str = "#ffffff"
    # Raw fabric.js JSON serialisation — front-end loads/saves verbatim.
    canvas_json: dict = Field(default_factory=lambda: {"version": "6", "objects": []})
    # Optional thumbnail (data URL or /uploads/... path) for the gallery.
    thumbnail: str = ""
    # Tracked just for analytics — the canvas itself is the contract.
    fields_used: List[str] = []
    active: bool = True
    created_by: str = ""
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)


PrintQtyStrategy = Literal["one_each", "inventory_qty", "custom"]
PrintOutputFormat = Literal["html", "pdf", "zpl", "epl"]


class StickerPrintJob(BaseModel):
    """Audit-log entry for every batch sticker print. Required by Feature 14."""
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=gen_id)
    template_id: str
    template_name: str = ""
    template_version: int = 1
    qty_strategy: PrintQtyStrategy = "one_each"
    output_format: PrintOutputFormat = "html"
    printer_label: str = ""        # free-text printer / device name
    product_ids: List[str] = []
    product_count: int = 0
    total_stickers: int = 0        # actual sticker count rendered after strategy applied
    reprint_of: Optional[str] = None  # original job id, when re-printing
    user_id: str = ""
    user_name: str = ""
    ip_address: str = ""
    notes: str = ""
    created_at: str = Field(default_factory=now_iso)


# ============================================================================
# V2.6 — E-WAY BILL MODULE (independent, integrates with Tax Invoice + Challan)
# ============================================================================
# Architecture note:
#   - Provider-agnostic. `provider` defaults to "LOCAL" (numbers issued by us);
#     a future "NIC_API" provider can be plugged in by replacing the number
#     generation + status update calls in the router. No model changes needed.
#   - Auto-filled from a linked Tax Invoice or Delivery Challan — supplier/
#     recipient/items/totals are snapshotted at creation time so a later edit
#     to the source invoice does NOT silently mutate the e-way bill.

EWayBillTransportMode = Literal["road", "rail", "air", "ship"]
EWayBillReason = Literal[
    "supply", "sales_return", "export", "import", "job_work", "skd", "ckd", "others"
]
EWayBillStatus = Literal["draft", "active", "cancelled"]
EWayBillProvider = Literal["LOCAL", "NIC_API"]


class EWayBillPartyBlock(BaseModel):
    """Snapshot of one side (supplier or recipient) of the consignment."""
    model_config = ConfigDict(extra="ignore")
    gstin: str = ""
    name: str = ""
    address: str = ""
    state: str = ""
    state_code: str = ""
    pincode: str = ""


class EWayBillLineItem(BaseModel):
    """Snapshot of one item on the e-way bill."""
    model_config = ConfigDict(extra="ignore")
    product_id: Optional[str] = None
    sku: str = ""
    description: str = ""
    hsn: str = ""
    qty: float = 0.0
    unit: str = "PCS"
    taxable_value: float = 0.0
    gst_percent: float = 18.0
    cgst_amount: float = 0.0
    sgst_amount: float = 0.0
    igst_amount: float = 0.0
    line_total: float = 0.0


class EWayBill(BaseModel):
    """E-Way Bill — generated from a Tax Invoice or Delivery Challan."""
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=gen_id)
    # Sequential public number, e.g. "EWB-2026-000001"
    eway_number: str = ""
    provider: EWayBillProvider = "LOCAL"
    status: EWayBillStatus = "active"

    # Source linkage — at least ONE of (invoice_id, challan_id) is set.
    invoice_id: Optional[str] = None
    invoice_number: Optional[str] = None
    challan_id: Optional[str] = None
    dc_number: Optional[str] = None
    franchise_id: Optional[str] = None

    # Document meta (snapshot of the source doc)
    transaction_type: str = "Regular"        # Regular / Bill-To-Ship-To etc.
    document_type: str = "Tax Invoice"       # "Tax Invoice" | "Delivery Challan"
    document_number: str = ""
    document_date: str = ""

    # Parties (snapshot — do NOT auto-mutate after creation)
    supplier: EWayBillPartyBlock = Field(default_factory=EWayBillPartyBlock)
    recipient: EWayBillPartyBlock = Field(default_factory=EWayBillPartyBlock)

    # Goods (snapshot)
    line_items: List[EWayBillLineItem] = []
    subtotal: float = 0.0
    cgst_total: float = 0.0
    sgst_total: float = 0.0
    igst_total: float = 0.0
    grand_total: float = 0.0

    # Transport details (user-entered)
    transporter_name: str = ""
    transporter_gstin: str = ""
    transporter_id: str = ""               # 15-char NIC transporter id
    lr_number: str = ""                    # LR / RR / Airway Bill no.
    vehicle_number: str = ""
    vehicle_type: str = "Regular"          # Regular / Over-Dimensional Cargo
    transport_mode: EWayBillTransportMode = "road"
    distance_km: float = 0.0
    reason: EWayBillReason = "supply"
    remarks: str = ""

    # Validity (computed: 1 day per 200 km for road; min 1 day)
    valid_from: str = ""
    valid_upto: str = ""

    # Optional cached artefacts (data URLs / paths). PDF is re-rendered on demand;
    # we only cache QR text + barcode value so they stay stable across re-renders.
    qr_payload: str = ""                   # plain text encoded into the QR
    barcode_value: str = ""                # the eway_number itself
    generated_pdf_path: str = ""           # filled if we ever write to disk; not required

    # Audit
    created_by: str = ""
    created_by_name: str = ""
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)
    cancelled_at: Optional[str] = None
    cancelled_reason: str = ""
