"""V2.6 — E-Way Bill Module (additive).

Independent module that integrates with Tax Invoice + Delivery Challan.

Endpoints:
  GET    /api/eway-bills                                     — list + filters
  POST   /api/eway-bills                                     — create (manual)
  POST   /api/eway-bills/from-invoice/{tid}                  — create from Tax Invoice
  POST   /api/eway-bills/from-challan/{dcid}                 — create from Delivery Challan
  GET    /api/eway-bills/{eid}                               — get one
  PUT    /api/eway-bills/{eid}                               — update transport details only
  POST   /api/eway-bills/{eid}/cancel                        — cancel (admin only)
  POST   /api/eway-bills/{eid}/duplicate                     — clone (new number, same data)
  GET    /api/eway-bills/{eid}/pdf                           — render the e-way bill PDF
  GET    /api/eway-bills/by-invoice/{tid}                    — find latest by tax invoice
  GET    /api/eway-bills/by-challan/{dcid}                   — find latest by delivery challan

Provider abstraction:
  generate_number()  — LOCAL: sequential EWB-YYYY-000001. Future: NIC_API call.
  push_to_provider() — LOCAL: no-op. Future: NIC_API SOAP/REST submit.
Switch by setting `EWB_PROVIDER` env var to "NIC_API" later; this router is
designed so the only changes needed are inside the two helpers above.
"""
from __future__ import annotations

import io
import os
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from auth_utils import require_roles, get_current_user
from models import (
    EWayBill, EWayBillLineItem, EWayBillPartyBlock,
    gen_id, now_iso,
)

logger = logging.getLogger(__name__)
router = APIRouter()

# ---- DI ----
_db = None
_log_audit = None


def init(db, log_audit_fn):
    global _db, _log_audit
    _db = db
    _log_audit = log_audit_fn


# ============================================================================
# Provider abstraction
# ============================================================================
EWB_PROVIDER = os.environ.get("EWB_PROVIDER", "LOCAL").upper()


async def generate_number() -> str:
    """Return the next public e-way bill number.

    LOCAL provider issues EWB-YYYY-000001 monotonically.
    NIC_API provider would call the official endpoint and return the assigned
    EBN. We pre-compute the format here so the rest of the system never has
    to know the difference.
    """
    if EWB_PROVIDER == "NIC_API":
        # TODO: integrate NIC EWB API and return the EBN it issues.
        # Until then we still fall back to LOCAL numbering so callers don't
        # crash in dev/staging.
        pass
    year = datetime.now(timezone.utc).year
    counter_key = f"eway_bill_{year}"
    doc = await _db.counters.find_one_and_update(
        {"_id": counter_key}, {"$inc": {"seq": 1}}, upsert=True, return_document=True,
    )
    seq = (doc or {}).get("seq", 1)
    return f"EWB-{year}-{str(seq).zfill(6)}"


async def push_to_provider(ewb: dict) -> dict:
    """LOCAL: no-op. NIC_API: POST to NIC and return updated provider fields.

    Designed as an injection point so the module is ready for the official
    API without rewriting any business logic.
    """
    if EWB_PROVIDER == "NIC_API":
        # TODO: call NIC API, return {"eway_number": "...", "valid_upto": "..."}
        return {}
    return {}


# ============================================================================
# Helpers
# ============================================================================
def _state_code_from_gstin(gstin: str) -> str:
    if not gstin or len(gstin) < 2:
        return ""
    return gstin[:2]


def _compute_validity(distance_km: float) -> tuple[str, str]:
    """1 day per 200 km (minimum 1 day) starting from now."""
    days = max(1, int((distance_km + 199) // 200))
    now = datetime.now(timezone.utc)
    valid_upto = now + timedelta(days=days)
    return now.isoformat(), valid_upto.isoformat()


def _build_qr_payload(ewb: dict) -> str:
    """Compact text payload encoded into the QR — verifiable by scanners."""
    return (
        f"EWB:{ewb.get('eway_number','')}|"
        f"INV:{ewb.get('document_number','')}|"
        f"SGST:{(ewb.get('supplier') or {}).get('gstin','')}|"
        f"RGST:{(ewb.get('recipient') or {}).get('gstin','')}|"
        f"VEH:{ewb.get('vehicle_number','')}|"
        f"DT:{(ewb.get('created_at','') or '')[:10]}"
    )


async def _serialize_invoice(inv: dict) -> dict:
    """Convert a TaxInvoice doc into snapshot fields for the EWayBill."""
    org = await _db.org_settings.find_one({"id": "org-settings"}, {"_id": 0}) or {}
    supplier = EWayBillPartyBlock(
        gstin=org.get("gstin", ""),
        name=org.get("legal_name", ""),
        address=", ".join(filter(None, [
            org.get("address_line1", ""), org.get("address_line2", ""),
            org.get("city", ""), org.get("state", ""),
        ])),
        state=org.get("state", ""),
        state_code=org.get("state_code", "") or _state_code_from_gstin(org.get("gstin", "")),
        pincode=org.get("pincode", ""),
    )
    recipient = EWayBillPartyBlock(
        gstin=inv.get("billing_gstin", ""),
        name=inv.get("billing_name", "") or inv.get("franchise_name", ""),
        address=inv.get("shipping_address", "") or inv.get("billing_address", ""),
        state=inv.get("billing_state", ""),
        state_code=inv.get("billing_state_code", "") or _state_code_from_gstin(inv.get("billing_gstin", "")),
        pincode="",
    )
    items: List[EWayBillLineItem] = []
    for li in inv.get("line_items", []) or []:
        items.append(EWayBillLineItem(
            product_id=li.get("product_id"),
            sku=li.get("sku", ""),
            description=li.get("description", ""),
            hsn=li.get("hsn", ""),
            qty=float(li.get("qty", 0) or 0),
            unit=li.get("unit", "PCS"),
            taxable_value=float(li.get("taxable_value", 0) or 0),
            gst_percent=float(li.get("gst_percent", 18) or 18),
            cgst_amount=float(li.get("cgst_amount", 0) or 0),
            sgst_amount=float(li.get("sgst_amount", 0) or 0),
            igst_amount=float(li.get("igst_amount", 0) or 0),
            line_total=float(li.get("line_total", 0) or 0),
        ))
    return {
        "supplier": supplier.model_dump(),
        "recipient": recipient.model_dump(),
        "line_items": [i.model_dump() for i in items],
        "subtotal": float(inv.get("subtotal", 0) or 0),
        "cgst_total": float(inv.get("cgst_total", 0) or 0),
        "sgst_total": float(inv.get("sgst_total", 0) or 0),
        "igst_total": float(inv.get("igst_total", 0) or 0),
        "grand_total": float(inv.get("grand_total", 0) or 0),
        "document_number": inv.get("invoice_number", "") or inv.get("id", ""),
        "document_date": inv.get("invoice_date", "") or "",
        "franchise_id": inv.get("franchise_id"),
        "document_type": "Tax Invoice",
    }


async def _serialize_challan(dc: dict) -> dict:
    """Convert a DeliveryChallan doc into snapshot fields. DC line items don't
    carry the same GST split as a tax invoice, so we approximate CGST/SGST/IGST
    proportionally on each line."""
    org = await _db.org_settings.find_one({"id": "org-settings"}, {"_id": 0}) or {}
    fr = await _db.franchises.find_one({"id": dc.get("franchise_id")}, {"_id": 0}) or {}
    supplier = EWayBillPartyBlock(
        gstin=org.get("gstin", ""),
        name=org.get("legal_name", ""),
        address=", ".join(filter(None, [
            org.get("address_line1", ""), org.get("address_line2", ""),
            org.get("city", ""), org.get("state", ""),
        ])),
        state=org.get("state", ""),
        state_code=org.get("state_code", "") or _state_code_from_gstin(org.get("gstin", "")),
        pincode=org.get("pincode", ""),
    )
    recipient = EWayBillPartyBlock(
        gstin=fr.get("gstin", ""),
        name=fr.get("name", "") or dc.get("franchise_name", ""),
        address=fr.get("address", ""),
        state=fr.get("state", ""),
        state_code=_state_code_from_gstin(fr.get("gstin", "")),
        pincode="",
    )
    items: List[EWayBillLineItem] = []
    subtotal = 0.0
    cgst_total = 0.0
    sgst_total = 0.0
    for li in dc.get("line_items", []) or []:
        qty = float(li.get("allocated_qty", li.get("requested_qty", 0)) or 0)
        unit_price = float(li.get("unit_price", 0) or 0)
        taxable = round(qty * unit_price, 2)
        cgst = round(taxable * 0.09, 2)
        sgst = round(taxable * 0.09, 2)
        items.append(EWayBillLineItem(
            product_id=li.get("product_id"),
            sku=li.get("sku", ""),
            description=li.get("product_name", ""),
            hsn="",
            qty=qty,
            unit="PCS",
            taxable_value=taxable,
            gst_percent=18.0,
            cgst_amount=cgst,
            sgst_amount=sgst,
            igst_amount=0.0,
            line_total=round(taxable + cgst + sgst, 2),
        ))
        subtotal += taxable
        cgst_total += cgst
        sgst_total += sgst
    return {
        "supplier": supplier.model_dump(),
        "recipient": recipient.model_dump(),
        "line_items": [i.model_dump() for i in items],
        "subtotal": round(subtotal, 2),
        "cgst_total": round(cgst_total, 2),
        "sgst_total": round(sgst_total, 2),
        "igst_total": 0.0,
        "grand_total": round(subtotal + cgst_total + sgst_total, 2),
        "document_number": dc.get("dc_number", "") or dc.get("id", ""),
        "document_date": (dc.get("created_at", "") or "")[:10],
        "franchise_id": dc.get("franchise_id"),
        "document_type": "Delivery Challan",
    }


def _redact_for_franchise(d: dict) -> dict:
    """Franchise users can view their own eway bills but we still strip
    fields that aren't relevant to them."""
    return d  # No sensitive fields beyond what they already see on the invoice.


# ============================================================================
# Schemas
# ============================================================================
class TransportInput(BaseModel):
    vehicle_number: str = ""
    transporter_name: str = ""
    transporter_gstin: str = ""
    transporter_id: str = ""
    lr_number: str = ""
    distance_km: float = 0.0
    transport_mode: Literal["road", "rail", "air", "ship"] = "road"
    vehicle_type: str = "Regular"
    reason: Literal["supply", "sales_return", "export", "import", "job_work", "skd", "ckd", "others"] = "supply"
    remarks: str = ""


class EWBCreateFromSource(TransportInput):
    """All transport details required at creation time."""
    pass


class EWBUpdate(TransportInput):
    pass


class EWBCancel(BaseModel):
    reason: str = ""


# ============================================================================
# Endpoints
# ============================================================================
@router.get("/eway-bills", tags=["eway_bills"])
async def list_eway_bills(
    franchise_id: Optional[str] = None,
    invoice_id: Optional[str] = None,
    challan_id: Optional[str] = None,
    vehicle: Optional[str] = None,
    transporter: Optional[str] = None,
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = 200,
    user: dict = Depends(get_current_user),
):
    query: dict = {}
    # Franchise scoping
    if user["role"] == "franchise_manager":
        query["franchise_id"] = user.get("franchise_id")
    elif franchise_id:
        query["franchise_id"] = franchise_id

    if invoice_id:
        query["invoice_id"] = invoice_id
    if challan_id:
        query["challan_id"] = challan_id
    if status:
        query["status"] = status
    if vehicle:
        query["vehicle_number"] = {"$regex": vehicle, "$options": "i"}
    if transporter:
        query["transporter_name"] = {"$regex": transporter, "$options": "i"}
    if q:
        query["$or"] = [
            {"eway_number": {"$regex": q, "$options": "i"}},
            {"document_number": {"$regex": q, "$options": "i"}},
            {"vehicle_number": {"$regex": q, "$options": "i"}},
            {"transporter_name": {"$regex": q, "$options": "i"}},
        ]
    if date_from or date_to:
        date_q: dict = {}
        if date_from:
            date_q["$gte"] = date_from
        if date_to:
            date_q["$lte"] = date_to + "T23:59:59"
        query["created_at"] = date_q

    docs = await _db.eway_bills.find(query, {"_id": 0}).sort("created_at", -1).limit(limit).to_list(limit)
    return docs


@router.get("/eway-bills/by-invoice/{tid}", tags=["eway_bills"])
async def get_eway_by_invoice(tid: str, user: dict = Depends(get_current_user)):
    doc = await _db.eway_bills.find_one(
        {"invoice_id": tid, "status": {"$ne": "cancelled"}},
        {"_id": 0}, sort=[("created_at", -1)],
    )
    return doc or {}


@router.get("/eway-bills/by-challan/{dcid}", tags=["eway_bills"])
async def get_eway_by_challan(dcid: str, user: dict = Depends(get_current_user)):
    doc = await _db.eway_bills.find_one(
        {"challan_id": dcid, "status": {"$ne": "cancelled"}},
        {"_id": 0}, sort=[("created_at", -1)],
    )
    return doc or {}


@router.get("/eway-bills/{eid}", tags=["eway_bills"])
async def get_eway_bill(eid: str, user: dict = Depends(get_current_user)):
    doc = await _db.eway_bills.find_one({"id": eid}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Not found")
    if user["role"] == "franchise_manager" and doc.get("franchise_id") != user.get("franchise_id"):
        raise HTTPException(403, "Forbidden")
    return doc


@router.post("/eway-bills/from-invoice/{tid}", tags=["eway_bills"])
async def create_eway_from_invoice(
    tid: str, body: EWBCreateFromSource, request: Request,
    user: dict = Depends(require_roles("super_admin", "warehouse_manager", "hub_accountant")),
):
    inv = await _db.tax_invoices.find_one({"id": tid}, {"_id": 0})
    if not inv:
        raise HTTPException(404, "Tax invoice not found")
    snap = await _serialize_invoice(inv)
    number = await generate_number()
    valid_from, valid_upto = _compute_validity(body.distance_km)
    ewb = EWayBill(
        eway_number=number,
        provider=EWB_PROVIDER,
        status="active",
        invoice_id=tid,
        invoice_number=inv.get("invoice_number", ""),
        franchise_id=snap["franchise_id"],
        document_type=snap["document_type"],
        document_number=snap["document_number"],
        document_date=snap["document_date"],
        supplier=EWayBillPartyBlock(**snap["supplier"]),
        recipient=EWayBillPartyBlock(**snap["recipient"]),
        line_items=[EWayBillLineItem(**i) for i in snap["line_items"]],
        subtotal=snap["subtotal"],
        cgst_total=snap["cgst_total"],
        sgst_total=snap["sgst_total"],
        igst_total=snap["igst_total"],
        grand_total=snap["grand_total"],
        vehicle_number=body.vehicle_number,
        transporter_name=body.transporter_name,
        transporter_gstin=body.transporter_gstin,
        transporter_id=body.transporter_id,
        lr_number=body.lr_number,
        distance_km=body.distance_km,
        transport_mode=body.transport_mode,
        vehicle_type=body.vehicle_type,
        reason=body.reason,
        remarks=body.remarks,
        valid_from=valid_from,
        valid_upto=valid_upto,
        barcode_value=number,
        created_by=user["id"],
        created_by_name=user.get("full_name", "") or user.get("email", ""),
    )
    doc = ewb.model_dump()
    doc["qr_payload"] = _build_qr_payload(doc)
    await _db.eway_bills.insert_one(doc)
    # Backlink on the invoice for reverse lookup convenience
    await _db.tax_invoices.update_one(
        {"id": tid}, {"$set": {"eway_bill_id": ewb.id, "eway_bill_number": number}},
    )
    await _log_audit(user, "eway_bill.create", "eway_bill", ewb.id,
                     after={"source": "invoice", "invoice_id": tid, "eway_number": number},
                     request=request)
    await push_to_provider(doc)
    doc.pop("_id", None)
    return doc


@router.post("/eway-bills/from-challan/{dcid}", tags=["eway_bills"])
async def create_eway_from_challan(
    dcid: str, body: EWBCreateFromSource, request: Request,
    user: dict = Depends(require_roles("super_admin", "warehouse_manager", "hub_accountant")),
):
    dc = await _db.delivery_challans.find_one({"id": dcid}, {"_id": 0})
    if not dc:
        raise HTTPException(404, "Delivery challan not found")
    snap = await _serialize_challan(dc)
    number = await generate_number()
    valid_from, valid_upto = _compute_validity(body.distance_km)
    ewb = EWayBill(
        eway_number=number,
        provider=EWB_PROVIDER,
        status="active",
        challan_id=dcid,
        dc_number=dc.get("dc_number", ""),
        franchise_id=snap["franchise_id"],
        document_type=snap["document_type"],
        document_number=snap["document_number"],
        document_date=snap["document_date"],
        supplier=EWayBillPartyBlock(**snap["supplier"]),
        recipient=EWayBillPartyBlock(**snap["recipient"]),
        line_items=[EWayBillLineItem(**i) for i in snap["line_items"]],
        subtotal=snap["subtotal"],
        cgst_total=snap["cgst_total"],
        sgst_total=snap["sgst_total"],
        igst_total=snap["igst_total"],
        grand_total=snap["grand_total"],
        vehicle_number=body.vehicle_number,
        transporter_name=body.transporter_name,
        transporter_gstin=body.transporter_gstin,
        transporter_id=body.transporter_id,
        lr_number=body.lr_number,
        distance_km=body.distance_km,
        transport_mode=body.transport_mode,
        vehicle_type=body.vehicle_type,
        reason=body.reason,
        remarks=body.remarks,
        valid_from=valid_from,
        valid_upto=valid_upto,
        barcode_value=number,
        created_by=user["id"],
        created_by_name=user.get("full_name", "") or user.get("email", ""),
    )
    doc = ewb.model_dump()
    doc["qr_payload"] = _build_qr_payload(doc)
    await _db.eway_bills.insert_one(doc)
    # Backlink on the DC
    await _db.delivery_challans.update_one(
        {"id": dcid}, {"$set": {"eway_bill_id": ewb.id, "eway_bill_number": number}},
    )
    await _log_audit(user, "eway_bill.create", "eway_bill", ewb.id,
                     after={"source": "challan", "challan_id": dcid, "eway_number": number},
                     request=request)
    await push_to_provider(doc)
    doc.pop("_id", None)
    return doc


@router.put("/eway-bills/{eid}", tags=["eway_bills"])
async def update_eway_bill(
    eid: str, body: EWBUpdate, request: Request,
    user: dict = Depends(require_roles("super_admin", "warehouse_manager", "hub_accountant")),
):
    existing = await _db.eway_bills.find_one({"id": eid}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Not found")
    if existing.get("status") == "cancelled":
        raise HTTPException(409, "Cannot edit a cancelled e-way bill")
    valid_from, valid_upto = _compute_validity(body.distance_km)
    update = body.model_dump()
    update["updated_at"] = now_iso()
    update["valid_from"] = valid_from
    update["valid_upto"] = valid_upto
    await _db.eway_bills.update_one({"id": eid}, {"$set": update})
    merged = {**existing, **update}
    merged["qr_payload"] = _build_qr_payload(merged)
    await _db.eway_bills.update_one({"id": eid}, {"$set": {"qr_payload": merged["qr_payload"]}})
    await _log_audit(user, "eway_bill.update", "eway_bill", eid,
                     before=existing, after=update, request=request)
    return merged


@router.post("/eway-bills/{eid}/cancel", tags=["eway_bills"])
async def cancel_eway_bill(
    eid: str, body: EWBCancel, request: Request,
    user: dict = Depends(require_roles("super_admin", "hub_accountant")),
):
    existing = await _db.eway_bills.find_one({"id": eid}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Not found")
    if existing.get("status") == "cancelled":
        raise HTTPException(409, "Already cancelled")
    await _db.eway_bills.update_one({"id": eid}, {"$set": {
        "status": "cancelled",
        "cancelled_at": now_iso(),
        "cancelled_reason": body.reason or "",
        "updated_at": now_iso(),
    }})
    await _log_audit(user, "eway_bill.cancel", "eway_bill", eid,
                     after={"reason": body.reason}, request=request)
    return {"ok": True}


@router.post("/eway-bills/{eid}/duplicate", tags=["eway_bills"])
async def duplicate_eway_bill(
    eid: str, request: Request,
    user: dict = Depends(require_roles("super_admin", "warehouse_manager", "hub_accountant")),
):
    src = await _db.eway_bills.find_one({"id": eid}, {"_id": 0})
    if not src:
        raise HTTPException(404, "Not found")
    new_id = gen_id()
    number = await generate_number()
    valid_from, valid_upto = _compute_validity(float(src.get("distance_km", 0) or 0))
    clone = {
        **src,
        "id": new_id,
        "eway_number": number,
        "status": "active",
        "valid_from": valid_from,
        "valid_upto": valid_upto,
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "cancelled_at": None,
        "cancelled_reason": "",
        "barcode_value": number,
        "created_by": user["id"],
        "created_by_name": user.get("full_name", "") or user.get("email", ""),
    }
    clone["qr_payload"] = _build_qr_payload(clone)
    await _db.eway_bills.insert_one(clone)
    clone.pop("_id", None)
    await _log_audit(user, "eway_bill.duplicate", "eway_bill", new_id,
                     after={"source_id": eid, "new_number": number}, request=request)
    return clone


@router.post("/eway-bills", tags=["eway_bills"])
async def create_eway_manual(
    body: EWBCreateFromSource, request: Request,
    invoice_id: Optional[str] = Query(None),
    challan_id: Optional[str] = Query(None),
    user: dict = Depends(require_roles("super_admin", "warehouse_manager", "hub_accountant")),
):
    """Convenience proxy — picks the right source helper based on query string."""
    if invoice_id:
        return await create_eway_from_invoice(invoice_id, body, request, user)
    if challan_id:
        return await create_eway_from_challan(challan_id, body, request, user)
    raise HTTPException(400, "Provide either invoice_id or challan_id query parameter.")


# ============================================================================
# PDF rendering
# ============================================================================
@router.get("/eway-bills/{eid}/pdf", tags=["eway_bills"])
async def eway_bill_pdf(eid: str, user: dict = Depends(get_current_user)):
    doc = await _db.eway_bills.find_one({"id": eid}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Not found")
    if user["role"] == "franchise_manager" and doc.get("franchise_id") != user.get("franchise_id"):
        raise HTTPException(403, "Forbidden")
    pdf = _render_eway_bill_pdf(doc)
    name = (doc.get("eway_number") or "draft").replace("/", "-")
    return StreamingResponse(
        io.BytesIO(pdf),
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="eway-bill-{name}.pdf"'},
    )


def _render_eway_bill_pdf(ewb: dict) -> bytes:
    """Government-style E-Way Bill PDF with QR + Code128 barcode."""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib import colors
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image,
    )
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.graphics.barcode import code128
    import qrcode

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4,
                            leftMargin=10 * mm, rightMargin=10 * mm,
                            topMargin=8 * mm, bottomMargin=10 * mm,
                            title=f"E-Way Bill {ewb.get('eway_number','')}")
    styles = getSampleStyleSheet()
    h_style = ParagraphStyle("hdr", parent=styles["Normal"], fontSize=8, leading=10)
    small = ParagraphStyle("sm", parent=styles["Normal"], fontSize=7, leading=9,
                            textColor=colors.HexColor("#555"))
    label = ParagraphStyle("lb", parent=styles["Normal"], fontSize=7, leading=9,
                            textColor=colors.HexColor("#777"))
    title = ParagraphStyle("ttl", parent=styles["Normal"], fontSize=15, leading=18,
                            alignment=1, spaceAfter=2, textColor=colors.HexColor("#0b3d91"))
    subtitle = ParagraphStyle("sub", parent=styles["Normal"], fontSize=8, leading=10,
                               alignment=1, textColor=colors.HexColor("#555"))
    section_hdr = ParagraphStyle("sec", parent=styles["Normal"], fontSize=8.5,
                                   leading=11, textColor=colors.white,
                                   backColor=colors.HexColor("#0b3d91"),
                                   leftIndent=4, spaceBefore=2, spaceAfter=2)
    elements: list = []

    # ---- Title ----
    elements.append(Paragraph("<b>e-Way Bill</b>", title))
    status_color = {"active": "#0a7f2e", "cancelled": "#a40000", "draft": "#666"}.get(
        (ewb.get("status") or "active").lower(), "#666",
    )
    elements.append(Paragraph(
        f"Generated from Servall ERP &nbsp;|&nbsp; "
        f"<font color='{status_color}'><b>{(ewb.get('status') or '').upper()}</b></font>",
        subtitle,
    ))
    elements.append(Spacer(1, 4))

    # ---- Section 1: E-Way Bill meta ----
    elements.append(Paragraph("&nbsp;<b>1. E-Way Bill Details</b>", section_hdr))
    meta_rows = [
        ["E-Way Bill No.", ewb.get("eway_number", ""), "Generated Date",
         (ewb.get("created_at", "") or "")[:19].replace("T", " ")],
        ["Generated By", ewb.get("created_by_name", "") or "Servall ERP",
         "Valid Upto", (ewb.get("valid_upto", "") or "")[:19].replace("T", " ")],
        ["Transaction Type", ewb.get("transaction_type", "Regular"),
         "Reason", (ewb.get("reason", "") or "").replace("_", " ").title()],
        ["Document Type", ewb.get("document_type", ""),
         "Document Number", ewb.get("document_number", "")],
        ["Document Date", ewb.get("document_date", ""),
         "Distance", f"{ewb.get('distance_km', 0):.0f} km"],
    ]
    meta_tbl = Table(meta_rows, colWidths=[34 * mm, 60 * mm, 32 * mm, 64 * mm])
    meta_tbl.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#666")),
        ("TEXTCOLOR", (2, 0), (2, -1), colors.HexColor("#666")),
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#F3F4F8")),
        ("BACKGROUND", (2, 0), (2, -1), colors.HexColor("#F3F4F8")),
        ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#BBB")),
        ("INNERGRID", (0, 0), (-1, -1), 0.2, colors.HexColor("#DDD")),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    elements.append(meta_tbl)
    elements.append(Spacer(1, 4))

    # ---- Section 2 + 3: FROM / TO side-by-side ----
    sup = ewb.get("supplier") or {}
    rec = ewb.get("recipient") or {}
    from_block = [
        Paragraph("<b>FROM</b>", label),
        Paragraph(f"<b>{sup.get('name','')}</b>", h_style),
        Paragraph(f"GSTIN: <b>{sup.get('gstin','')}</b>", h_style),
        Paragraph(sup.get("address", ""), h_style),
        Paragraph(f"State: {sup.get('state','')} ({sup.get('state_code','')})  "
                   f"Pincode: {sup.get('pincode','')}", h_style),
    ]
    to_block = [
        Paragraph("<b>TO</b>", label),
        Paragraph(f"<b>{rec.get('name','')}</b>", h_style),
        Paragraph(f"GSTIN: <b>{rec.get('gstin','') or '—'}</b>", h_style),
        Paragraph(rec.get("address", ""), h_style),
        Paragraph(f"State: {rec.get('state','')} ({rec.get('state_code','')})  "
                   f"Pincode: {rec.get('pincode','')}", h_style),
    ]
    party_tbl = Table([[from_block, to_block]], colWidths=[95 * mm, 95 * mm])
    party_tbl.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#BBB")),
        ("LINEAFTER", (0, 0), (0, -1), 0.4, colors.HexColor("#BBB")),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    elements.append(Paragraph("&nbsp;<b>2. Consignor / Consignee</b>", section_hdr))
    elements.append(party_tbl)
    elements.append(Spacer(1, 4))

    # ---- Section 4: Goods ----
    elements.append(Paragraph("&nbsp;<b>3. Goods Details</b>", section_hdr))
    is_inter = (ewb.get("igst_total", 0) or 0) > 0
    if is_inter:
        header = ["HSN", "Product", "Qty", "Unit", "Taxable", "IGST", "Amount"]
    else:
        header = ["HSN", "Product", "Qty", "Unit", "Taxable", "CGST", "SGST", "Amount"]
    rows = [header]
    for li in ewb.get("line_items", []) or []:
        if is_inter:
            rows.append([
                li.get("hsn", ""),
                Paragraph(
                    f"<b>{li.get('description','')}</b>"
                    f"<br/><font size=6 color='#888'>SKU: {li.get('sku','')}</font>",
                    h_style,
                ),
                f"{float(li.get('qty',0)):g}",
                li.get("unit", ""),
                f"{li.get('taxable_value',0):.2f}",
                f"{li.get('igst_amount',0):.2f}",
                f"{li.get('line_total',0):.2f}",
            ])
        else:
            rows.append([
                li.get("hsn", ""),
                Paragraph(
                    f"<b>{li.get('description','')}</b>"
                    f"<br/><font size=6 color='#888'>SKU: {li.get('sku','')}</font>",
                    h_style,
                ),
                f"{float(li.get('qty',0)):g}",
                li.get("unit", ""),
                f"{li.get('taxable_value',0):.2f}",
                f"{li.get('cgst_amount',0):.2f}",
                f"{li.get('sgst_amount',0):.2f}",
                f"{li.get('line_total',0):.2f}",
            ])
    if is_inter:
        col_widths = [16 * mm, 70 * mm, 14 * mm, 12 * mm, 22 * mm, 20 * mm, 26 * mm]
    else:
        col_widths = [16 * mm, 60 * mm, 12 * mm, 10 * mm, 20 * mm, 18 * mm, 18 * mm, 26 * mm]
    items_tbl = Table(rows, colWidths=col_widths, repeatRows=1)
    items_tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0b3d91")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 7.5),
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#BBB")),
        ("INNERGRID", (0, 0), (-1, -1), 0.2, colors.HexColor("#DDD")),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    elements.append(items_tbl)
    elements.append(Spacer(1, 4))

    # ---- Totals strip ----
    tot_rows = [["Subtotal", f"Rs {ewb.get('subtotal',0):.2f}"]]
    if is_inter:
        tot_rows.append(["IGST", f"Rs {ewb.get('igst_total',0):.2f}"])
    else:
        tot_rows.append(["CGST", f"Rs {ewb.get('cgst_total',0):.2f}"])
        tot_rows.append(["SGST", f"Rs {ewb.get('sgst_total',0):.2f}"])
    tot_rows.append(["GRAND TOTAL", f"Rs {ewb.get('grand_total',0):.2f}"])
    tot_tbl = Table(tot_rows, colWidths=[60 * mm, 40 * mm])
    tot_tbl.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, -2), 8),
        ("FONTSIZE", (0, -1), (-1, -1), 9.5),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#0b3d91")),
        ("TEXTCOLOR", (0, -1), (-1, -1), colors.white),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#BBB")),
        ("INNERGRID", (0, 0), (-1, -1), 0.2, colors.HexColor("#DDD")),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    tot_wrap = Table([["", tot_tbl]], colWidths=[90 * mm, 100 * mm])
    tot_wrap.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
    elements.append(tot_wrap)
    elements.append(Spacer(1, 4))

    # ---- Section 5: Transport ----
    elements.append(Paragraph("&nbsp;<b>4. Transport Details</b>", section_hdr))
    trans_rows = [
        ["Transporter", ewb.get("transporter_name", "") or "—",
         "Transporter GSTIN/ID", ewb.get("transporter_gstin", "") or ewb.get("transporter_id", "") or "—"],
        ["Vehicle Number", ewb.get("vehicle_number", "") or "—",
         "Vehicle Type", ewb.get("vehicle_type", "Regular")],
        ["Mode", (ewb.get("transport_mode", "") or "").title(),
         "LR / Doc No.", ewb.get("lr_number", "") or "—"],
        ["Distance", f"{ewb.get('distance_km', 0):.0f} km",
         "Remarks", ewb.get("remarks", "") or "—"],
    ]
    trans_tbl = Table(trans_rows, colWidths=[34 * mm, 60 * mm, 32 * mm, 64 * mm])
    trans_tbl.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#666")),
        ("TEXTCOLOR", (2, 0), (2, -1), colors.HexColor("#666")),
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#F3F4F8")),
        ("BACKGROUND", (2, 0), (2, -1), colors.HexColor("#F3F4F8")),
        ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#BBB")),
        ("INNERGRID", (0, 0), (-1, -1), 0.2, colors.HexColor("#DDD")),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    elements.append(trans_tbl)
    elements.append(Spacer(1, 6))

    # ---- Footer: QR + barcode + signature ----
    qr_payload = ewb.get("qr_payload") or _build_qr_payload(ewb)
    qr_img = qrcode.make(qr_payload)
    qr_buf = io.BytesIO()
    qr_img.save(qr_buf, format="PNG")
    qr_buf.seek(0)
    qr_flowable = Image(qr_buf, width=32 * mm, height=32 * mm)

    # Code128 barcode for the EWB number — drawn directly via canvas
    barcode_value = ewb.get("barcode_value", "") or ewb.get("eway_number", "EWB-UNKNOWN")
    bc = code128.Code128(barcode_value, barHeight=14 * mm, barWidth=0.35 * mm,
                         humanReadable=False)

    from reportlab.platypus import Flowable

    class _BarcodeFlowable(Flowable):
        def __init__(self, barcode_obj, label):
            super().__init__()
            self.barcode = barcode_obj
            self.label = label
            self.width = max(80 * mm, barcode_obj.width)
            self.height = 22 * mm

        def draw(self):
            # Centre the barcode horizontally inside the flowable
            x = max(0, (self.width - self.barcode.width) / 2)
            self.barcode.drawOn(self.canv, x, 6)
            self.canv.setFont("Helvetica", 7)
            self.canv.setFillColor(colors.HexColor("#666"))
            self.canv.drawCentredString(self.width / 2, 0, self.label)

    bc_flowable = _BarcodeFlowable(bc, barcode_value)

    sig_block = [
        Spacer(1, 18),
        Paragraph("________________________", h_style),
        Paragraph("<b>Authorised Signatory</b>", small),
        Paragraph(f"For <b>{sup.get('name','')}</b>", small),
    ]

    footer_tbl = Table(
        [[
            [Paragraph("<b>Scan QR</b>", label), qr_flowable],
            [Paragraph("<b>Barcode</b>", label), bc_flowable],
            sig_block,
        ]],
        colWidths=[44 * mm, 86 * mm, 60 * mm],
    )
    footer_tbl.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#BBB")),
        ("LINEAFTER", (0, 0), (1, -1), 0.4, colors.HexColor("#DDD")),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    elements.append(footer_tbl)
    elements.append(Spacer(1, 4))
    elements.append(Paragraph(
        "Generated from Servall ERP · "
        f"Provider: {ewb.get('provider', 'LOCAL')} · "
        "This document is system-generated and does not require a physical signature unless dispatched.",
        small,
    ))

    def _on_page(canvas, doc_):
        canvas.saveState()
        canvas.setFont("Helvetica", 7)
        canvas.setFillColor(colors.HexColor("#888"))
        canvas.drawRightString(A4[0] - 10 * mm, 6 * mm,
                                f"Page {doc_.page}")
        canvas.restoreState()

    doc.build(elements, onFirstPage=_on_page, onLaterPages=_on_page)
    return buf.getvalue()
