"""V2.5 Phase 2 — Sticker / Label Management Module.

A self-contained module: templates + print history. Completely decoupled from
inventory — templates can reference *any* product via the binding API, but the
sticker engine itself knows nothing about inventory rules. This is by design so
the module can later host: warehouse labels, dealer shipping labels, QR rack
labels, vendor box labels, multilingual stickers etc. without architectural
churn.

Endpoints
---------
    GET    /api/sticker-templates                   list templates
    POST   /api/sticker-templates                   create
    GET    /api/sticker-templates/{id}              get one
    PUT    /api/sticker-templates/{id}              update (name/canvas/...)
    DELETE /api/sticker-templates/{id}              delete (soft → active=false)
    POST   /api/sticker-templates/{id}/duplicate    'Save As' helper

    GET    /api/sticker-templates/{id}/preview-data?product_id=...
        → returns the dictionary of field values the designer / batch print
          page binds {{placeholders}} against.

    POST   /api/sticker-print-jobs                  record an audit job
    GET    /api/sticker-print-jobs                  list with filters

The actual rendering, barcode/QR generation and printing happens in the
browser via fabric.js + bwip-js. The backend is purely the system of record.
"""
from __future__ import annotations
from typing import List, Optional
from datetime import datetime
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, Query
from pydantic import BaseModel, ConfigDict

from auth_utils import get_current_user, require_roles
from models import (
    StickerTemplate, StickerPrintJob, StickerType,
    PrintQtyStrategy, PrintOutputFormat, gen_id, now_iso,
)

logger = logging.getLogger("servall.stickers")

router = APIRouter(prefix="/api", tags=["stickers"])
_db = None  # type: ignore[assignment]


def init(db_handle):
    """Wire up the shared Motor DB handle (server.py calls this on startup)."""
    global _db
    _db = db_handle


async def _log_audit(user: dict, action: str, target_id: str, before=None, after=None,
                      request: Request | None = None) -> None:
    """Best-effort audit log. We swallow errors — auditing must never break
    the user's call."""
    try:
        entry = {
            "id": gen_id(),
            "user_id": user.get("id"),
            "user_email": user.get("email"),
            "action": action,
            "entity_type": "sticker_template" if "template" in action else "sticker_print_job",
            "entity_id": target_id,
            "before": before,
            "after": after,
            "ip": (request.client.host if (request and request.client) else None),
            "ts": now_iso(),
        }
        await _db.audit_logs.insert_one(entry)
    except Exception as exc:  # pragma: no cover
        logger.warning("audit log failed: %s", exc)


# ---------------------------------------------------------------------------
# Sticker Templates
# ---------------------------------------------------------------------------
class StickerTemplateIn(BaseModel):
    name: str
    sticker_type: StickerType = "custom"
    description: str = ""
    width_mm: float = 50.0
    height_mm: float = 30.0
    dpi: int = 203
    background_color: str = "#ffffff"
    canvas_json: dict = {"version": "6", "objects": []}
    thumbnail: str = ""
    fields_used: List[str] = []


@router.get("/sticker-templates")
async def list_templates(
    sticker_type: Optional[StickerType] = None,
    active: Optional[bool] = True,
    q: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    qf: dict = {}
    if active is not None:
        qf["active"] = active
    if sticker_type:
        qf["sticker_type"] = sticker_type
    if q:
        qf["name"] = {"$regex": q, "$options": "i"}
    docs = await _db.sticker_templates.find(qf, {"_id": 0}).sort("updated_at", -1).to_list(500)
    return docs


# NOTE: this route MUST be declared BEFORE `/sticker-templates/{tid}` otherwise
# FastAPI's path matcher captures the literal segment "preview-data" as a tid.
@router.get("/sticker-templates/preview-data")
async def sticker_preview_data(
    product_id: Optional[str] = None,
    template_id: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """Return the bag of variables a sticker template can bind to.

    Supplying product_id pulls live inventory data. Without it, sample values
    are returned so the designer canvas always renders something — designers
    shouldn't have to pick a product just to lay out a template."""
    org = await _db.org_settings.find_one({"id": "org_settings"}, {"_id": 0}) or {}
    today = now_iso()[:10]
    data = {
        "today": today,
        "company_name": org.get("legal_name") or org.get("trade_name", "Servall Auto Parts"),
        "company_address": org.get("address", ""),
        "company_gstin": org.get("gstin", ""),
        "dealer_name": "",
        "custom_footer": "",
        "sku": "SAMPLE-001",
        "name": "Sample Product Name",
        "brand": "Sample Brand",
        "category": "Sample Category",
        "hsn": "8708",
        "vehicle_compatibility": "Universal",
        "mrp": 0,
        "selling_price": 0,
        "franchise_price": 0,
        "landing_price": 0,
        "batch_number": f"B-{today.replace('-', '')}",
        "mfg_date": today,
        "exp_date": "",
        "quantity": 1,
        "barcode_value": "1234567890123",
        "qr_value": "https://servall.example/sku/SAMPLE-001",
    }
    if product_id:
        p = await _db.products.find_one({"id": product_id}, {"_id": 0})
        if not p:
            raise HTTPException(404, "Product not found")
        data.update({
            "sku": p.get("sku", data["sku"]),
            "name": p.get("name", data["name"]),
            "brand": p.get("brand", data["brand"]),
            "category": p.get("category", data["category"]),
            "hsn": p.get("hsn", data["hsn"]),
            "vehicle_compatibility": p.get("vehicle_compatibility") or p.get("vehicle") or data["vehicle_compatibility"],
            "mrp": p.get("mrp", 0) or 0,
            "selling_price": p.get("franchise_price", 0) or p.get("mrp", 0) or 0,
            "franchise_price": p.get("franchise_price", 0) or 0,
            "landing_price": p.get("landing_price", 0) or 0,
            "quantity": int(p.get("hub_stock", 0) or 0),
            "barcode_value": p.get("barcode") or p.get("sku", data["barcode_value"]),
            "qr_value": p.get("qr") or f"sku:{p.get('sku', data['sku'])}",
        })
    return data


@router.get("/sticker-templates/{tid}")
async def get_template(tid: str, user: dict = Depends(get_current_user)):
    doc = await _db.sticker_templates.find_one({"id": tid}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Template not found")
    return doc


@router.post("/sticker-templates", response_model=StickerTemplate)
async def create_template(body: StickerTemplateIn, request: Request,
                          user: dict = Depends(require_roles("super_admin", "hub_accountant", "warehouse_manager"))):
    t = StickerTemplate(
        **body.model_dump(),
        created_by=user.get("id", ""),
    )
    await _db.sticker_templates.insert_one(t.model_dump())
    await _log_audit(user, "sticker_template.create", t.id, after={"name": t.name}, request=request)
    return t


@router.put("/sticker-templates/{tid}", response_model=StickerTemplate)
async def update_template(tid: str, body: StickerTemplateIn, request: Request,
                          user: dict = Depends(require_roles("super_admin", "hub_accountant", "warehouse_manager"))):
    cur = await _db.sticker_templates.find_one({"id": tid}, {"_id": 0})
    if not cur:
        raise HTTPException(404, "Template not found")
    payload = body.model_dump()
    payload["updated_at"] = now_iso()
    await _db.sticker_templates.update_one({"id": tid}, {"$set": payload})
    await _log_audit(user, "sticker_template.update", tid,
                     before={"name": cur.get("name")},
                     after={"name": payload.get("name")}, request=request)
    return StickerTemplate(**{**cur, **payload, "id": tid})


@router.delete("/sticker-templates/{tid}")
async def delete_template(tid: str, request: Request,
                          user: dict = Depends(require_roles("super_admin"))):
    cur = await _db.sticker_templates.find_one({"id": tid}, {"_id": 0})
    if not cur:
        raise HTTPException(404, "Template not found")
    # Soft delete — preserves audit history pointing at this template.
    await _db.sticker_templates.update_one({"id": tid},
        {"$set": {"active": False, "updated_at": now_iso()}})
    await _log_audit(user, "sticker_template.delete", tid, before={"name": cur.get("name")}, request=request)
    return {"ok": True}


@router.post("/sticker-templates/{tid}/duplicate")
async def duplicate_template(tid: str, request: Request,
                              user: dict = Depends(require_roles("super_admin", "hub_accountant", "warehouse_manager"))):
    cur = await _db.sticker_templates.find_one({"id": tid}, {"_id": 0})
    if not cur:
        raise HTTPException(404, "Template not found")
    copy_doc = {
        **cur,
        "id": gen_id(),
        "name": f"{cur.get('name', 'Untitled')} (copy)",
        "active": True,
        "created_by": user.get("id", ""),
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    await _db.sticker_templates.insert_one(copy_doc)
    await _log_audit(user, "sticker_template.duplicate", copy_doc["id"],
                     after={"from": tid, "name": copy_doc["name"]}, request=request)
    copy_doc.pop("_id", None)
    return copy_doc


# ---------------------------------------------------------------------------
# Data Binding — what {{placeholders}} resolve to
# ---------------------------------------------------------------------------
# (preview-data endpoint declared near list_templates above so FastAPI route
# matching picks it up before the {tid} path variable.)


# ---------------------------------------------------------------------------
# Print Jobs (audit log)
# ---------------------------------------------------------------------------
class StickerPrintJobIn(BaseModel):
    template_id: str
    qty_strategy: PrintQtyStrategy = "one_each"
    output_format: PrintOutputFormat = "html"
    printer_label: str = ""
    product_ids: List[str] = []
    total_stickers: int = 0
    reprint_of: Optional[str] = None
    notes: str = ""


@router.post("/sticker-print-jobs", response_model=StickerPrintJob)
async def record_print_job(body: StickerPrintJobIn, request: Request,
                            user: dict = Depends(get_current_user)):
    tpl = await _db.sticker_templates.find_one({"id": body.template_id}, {"_id": 0})
    if not tpl:
        raise HTTPException(404, "Template not found")
    job = StickerPrintJob(
        template_id=body.template_id,
        template_name=tpl.get("name", ""),
        template_version=1,
        qty_strategy=body.qty_strategy,
        output_format=body.output_format,
        printer_label=body.printer_label,
        product_ids=body.product_ids or [],
        product_count=len(body.product_ids or []),
        total_stickers=max(0, int(body.total_stickers or 0)),
        reprint_of=body.reprint_of,
        user_id=user.get("id", ""),
        user_name=user.get("email", ""),
        ip_address=(request.client.host if request.client else ""),
        notes=body.notes,
    )
    await _db.sticker_print_jobs.insert_one(job.model_dump())
    await _log_audit(user, "sticker_print.record", job.id,
                     after={"template": tpl.get("name"), "count": job.total_stickers,
                            "output": body.output_format}, request=request)
    return job


@router.get("/sticker-print-jobs")
async def list_print_jobs(
    template_id: Optional[str] = None,
    limit: int = Query(200, ge=1, le=1000),
    user: dict = Depends(get_current_user),
):
    qf: dict = {}
    if template_id:
        qf["template_id"] = template_id
    docs = await _db.sticker_print_jobs.find(qf, {"_id": 0}).sort("created_at", -1).to_list(limit)
    return docs


@router.get("/sticker-print-jobs/{jid}/reprint-payload")
async def get_reprint_payload(jid: str, user: dict = Depends(get_current_user)):
    """Return the data needed to re-print a previous job (template + product list).
    Caller is expected to POST a new /sticker-print-jobs with reprint_of=jid."""
    job = await _db.sticker_print_jobs.find_one({"id": jid}, {"_id": 0})
    if not job:
        raise HTTPException(404, "Job not found")
    tpl = await _db.sticker_templates.find_one({"id": job["template_id"]}, {"_id": 0})
    return {
        "job": job,
        "template": tpl,
    }
