"""V2.2 — Provider-configurable OCR service with dual-confidence scoring.

Default: Gemini 3 Flash (env OCR_MODEL).
Outputs structured JSON in V2.2 schema (vendor + items + per-row validation flags
+ per-row LLM self-reported confidence + heuristic confidence + combined).

Backward compatible: also emits legacy keys (line_items, gst_percent, line_total)
so existing /invoices/upload code in server.py keeps working without changes.
"""
from __future__ import annotations
import os
import json
import logging
import re
from typing import Optional

from emergentintegrations.llm.chat import LlmChat, UserMessage, FileContentWithMimeType

logger = logging.getLogger(__name__)

# ---------- Provider configuration ----------
DEFAULT_PROVIDER = "gemini"
DEFAULT_MODEL = "gemini-3-flash-preview"
DEFAULT_LLM_WEIGHT = 0.6  # combined = w*llm + (1-w)*heuristic


def _get_provider_model() -> tuple[str, str]:
    return (
        os.environ.get("OCR_PROVIDER", DEFAULT_PROVIDER).strip().lower() or DEFAULT_PROVIDER,
        os.environ.get("OCR_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL,
    )


def _get_llm_weight() -> float:
    try:
        w = float(os.environ.get("OCR_CONFIDENCE_LLM_WEIGHT", DEFAULT_LLM_WEIGHT))
        return max(0.0, min(1.0, w))
    except Exception:
        return DEFAULT_LLM_WEIGHT


# ---------- V2.2 strict-JSON prompts ----------
INVOICE_PROMPT = """You are an expert at parsing Indian B2B tax/purchase invoices for automotive spare parts.
Read the attached invoice (PDF or image) and return ONLY valid JSON — no prose, no markdown fences.

Required JSON schema:
{
  "vendor_name": string,
  "invoice_number": string,
  "invoice_date": "YYYY-MM-DD",
  "total_amount": number,
  "cgst": number,
  "sgst": number,
  "igst": number,
  "overall_confidence": number,        // 0..1 your self-assessed confidence for the whole invoice
  "items": [
    {
      "description": string,           // exact product description as printed
      "item_alias": string,             // vendor's internal item code / alias if shown (e.g. RES02, AT24026); else ""
      "hsn": string,                    // HSN code as printed; never empty if column exists; else ""
      "qty": number,                    // numeric quantity, > 0 for valid rows
      "unit": string,                   // PCS / BOX / SET / LTR etc.
      "price": number,                  // unit price / rate
      "cgst_percent": number,
      "sgst_percent": number,
      "net_amount": number,             // net line total Rs
      "confidence": number              // 0..1 your self-assessed confidence for THIS row
    }
  ]
}

EXTRACTION RULES (critical):
1. ALWAYS extract HSN from the HSN column. If you cannot find it for a row, return "" and DO NOT invent one.
2. ALWAYS extract qty from the Qty column. Negative or zero qty is suspicious — flag by returning 0.
3. item_alias is the vendor's short SKU/code column (often labeled "Item Alias" / "Item Code" / "Code"). Empty string if not present.
4. Preserve the original description text verbatim — do not paraphrase.
5. If the invoice continues to a second page ("Totals c/o"), include ONLY the rows visible in this image.
6. Numbers must be plain JSON numbers (no commas, no currency symbol). Use 0 if illegible.
7. If a field is unreadable, use "" for strings or 0 for numbers — never null.
8. CONFIDENCE: rate each row honestly. 1.0 = perfectly legible printed line; 0.7 = mostly clear with one ambiguous field; 0.4 = handwritten/smudged/partially obscured; 0.2 = mostly guessing.
9. overall_confidence should reflect your end-to-end certainty on the invoice header (vendor, number, date, totals).

Return the JSON object ONLY."""


PHOTO_ORDER_PROMPT = """You are an expert at reading hand-written or printed parts order sheets used by automotive franchises in India.

Read the attached image and return ONLY valid JSON — no prose, no markdown fences.

Schema:
{
  "items": [
    {"sku": string, "description": string, "qty": number}
  ]
}

Rules:
1. "sku" = the part code/SKU/item code if visible (e.g. SPK-BAJ-001, RES02, AT24026); else "".
2. "description" = product name/description as written; else "".
3. "qty" = numeric quantity (default 1 if unclear).
4. Skip header rows, totals, dates, signatures.
5. Each line in the order sheet = one item.

Return the JSON object ONLY."""


# ---------- Helpers ----------
def _clean_json_text(text: str) -> str:
    """Strip markdown fences and pre/post junk, return raw JSON string."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```\s*$", "", text)
        text = text.strip()
    if not text.startswith("{"):
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            text = m.group(0)
    return text


def _build_chat(session_id: str, system_message: str) -> LlmChat:
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise RuntimeError("EMERGENT_LLM_KEY not configured in backend/.env")
    provider, model = _get_provider_model()
    return LlmChat(
        api_key=api_key,
        session_id=session_id,
        system_message=system_message,
    ).with_model(provider, model)


def _clip01(x) -> float:
    try:
        v = float(x)
    except Exception:
        return 0.0
    return max(0.0, min(1.0, v))


# ---------- Validation layer ----------
def _validate_item(item: dict) -> dict:
    """Return validation flags + heuristic & combined confidence for an item row.

    Heuristic confidence is purely rule-based.
    LLM confidence is read from item.confidence (if present).
    Combined = w*llm + (1-w)*heuristic
    """
    qty_raw = item.get("qty")
    try:
        qty = float(qty_raw) if qty_raw is not None else 0.0
    except Exception:
        qty = 0.0
    hsn = (item.get("hsn") or "").strip()
    desc = (item.get("description") or "").strip()
    unit = (item.get("unit") or "").strip()

    qty_valid = qty > 0
    hsn_valid = bool(hsn) and re.fullmatch(r"\d{4,8}", hsn) is not None
    desc_valid = bool(desc)
    unit_valid = bool(unit)

    # Heuristic confidence — count passing rules + price/net bonuses
    rules = [qty_valid, hsn_valid, desc_valid, unit_valid]
    score = sum(1 for r in rules if r) / len(rules)
    try:
        if float(item.get("price") or 0) > 0:
            score = min(1.0, score + 0.05)
    except Exception:
        pass
    try:
        if float(item.get("net_amount") or 0) > 0:
            score = min(1.0, score + 0.05)
    except Exception:
        pass
    heuristic_confidence = round(score, 3)

    # LLM self-reported confidence (default 1.0 if model didn't emit one — back-compat)
    llm_confidence = _clip01(item.get("confidence", 1.0))

    # Combined (weighted)
    w = _get_llm_weight()
    combined = round(w * llm_confidence + (1 - w) * heuristic_confidence, 3)

    # Warnings — surface human-readable reasons
    warnings: list[str] = []
    if not qty_valid:
        warnings.append("missing_qty" if qty == 0 else "invalid_qty")
    if not hsn_valid:
        warnings.append("missing_hsn" if not hsn else "invalid_hsn")
    if not desc_valid:
        warnings.append("missing_description")
    if not unit_valid:
        warnings.append("missing_unit")

    return {
        "qty_valid": qty_valid,
        "hsn_valid": hsn_valid,
        "desc_valid": desc_valid,
        "unit_valid": unit_valid,
        "row_valid": qty_valid and hsn_valid and desc_valid,  # unit kept soft (warning only)
        "llm_confidence": llm_confidence,
        "heuristic_confidence": heuristic_confidence,
        "confidence": combined,
        "warnings": warnings,
    }


def _to_legacy_line_item(item: dict) -> dict:
    """Map V2.2 schema → legacy server.py InvoiceLineItem-compatible dict."""
    qty = float(item.get("qty") or 0)
    price = float(item.get("price") or 0)
    cgst = float(item.get("cgst_percent") or 0)
    sgst = float(item.get("sgst_percent") or 0)
    gst_percent = cgst + sgst
    net = float(item.get("net_amount") or 0)
    if net <= 0 and qty > 0 and price > 0:
        net = round(qty * price, 2)
    return {
        "product_name": item.get("description") or "",
        "sku": item.get("item_alias") or "",  # vendor alias → used for SKU lookup
        "hsn_code": item.get("hsn") or "",
        "quantity": qty,
        "unit_price": price,
        "gst_percent": gst_percent or 18.0,
        "line_total": net,
        # V2.1 extras
        "item_alias": item.get("item_alias") or "",
        "unit": item.get("unit") or "",
        "cgst_percent": cgst,
        "sgst_percent": sgst,
        "net_amount": net,
        "qty_valid": item.get("qty_valid", qty > 0),
        "hsn_valid": item.get("hsn_valid", bool(item.get("hsn"))),
        "desc_valid": item.get("desc_valid", bool(item.get("description"))),
        "unit_valid": item.get("unit_valid", bool(item.get("unit"))),
        "row_valid": item.get("row_valid", True),
        # V2.2 confidence split
        "confidence": item.get("confidence", 1.0),
        "llm_confidence": item.get("llm_confidence", 1.0),
        "heuristic_confidence": item.get("heuristic_confidence", 1.0),
        "warnings": item.get("warnings", []),
    }


# ---------- Public API ----------
async def parse_invoice(file_path: str, mime_type: str) -> dict:
    """Run multimodal OCR on a vendor invoice. Returns a dict combining V2.2 + legacy keys.

    Output keys (used by server.py):
      vendor_name, invoice_number, invoice_date, total_amount, cgst, sgst, igst,
      items[]            (V2.2 — with confidence split)
      line_items[]       (legacy — auto-generated for back-compat)
      confidence_score   (avg combined)
      llm_confidence     (avg LLM self-reported)
      heuristic_confidence (avg heuristic)
      provider, model
      _raw, _error (optional)
    """
    provider, model = _get_provider_model()
    try:
        chat = _build_chat(f"invoice-ocr-{os.path.basename(file_path)}", INVOICE_PROMPT)
        attachment = FileContentWithMimeType(file_path=file_path, mime_type=mime_type)
        msg = UserMessage(
            text="Parse this invoice and return the JSON exactly as specified, including per-row confidence.",
            file_contents=[attachment],
        )
        response = await chat.send_message(msg)
        text = response if isinstance(response, str) else str(response)
        cleaned = _clean_json_text(text)
        data = json.loads(cleaned)
    except json.JSONDecodeError as e:
        logger.warning("OCR JSON decode failed: %s", e)
        return _empty_response(f"Could not parse JSON: {str(e)[:140]}", provider, model)
    except Exception as e:
        logger.exception("OCR failed")
        return _empty_response(f"OCR error: {str(e)[:140]}", provider, model)

    items = data.get("items") or data.get("line_items") or []
    if not isinstance(items, list):
        items = []

    # Validate + enrich each row
    validated_items: list[dict] = []
    combined_scores: list[float] = []
    llm_scores: list[float] = []
    heur_scores: list[float] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        flags = _validate_item(it)
        merged = {**it, **flags}
        validated_items.append(merged)
        combined_scores.append(flags["confidence"])
        llm_scores.append(flags["llm_confidence"])
        heur_scores.append(flags["heuristic_confidence"])

    legacy_lines = [_to_legacy_line_item(x) for x in validated_items]

    overall_llm = _clip01(data.get("overall_confidence", 0))
    # Prefer explicit overall_confidence if model provided one; else average of rows
    avg_llm = round(overall_llm if overall_llm > 0 else (sum(llm_scores) / len(llm_scores) if llm_scores else 0.0), 3)
    avg_heur = round(sum(heur_scores) / len(heur_scores), 3) if heur_scores else 0.0
    w = _get_llm_weight()
    avg_combined = round(w * avg_llm + (1 - w) * avg_heur, 3)

    return {
        "vendor_name": data.get("vendor_name", "") or "",
        "invoice_number": data.get("invoice_number", "") or "",
        "invoice_date": data.get("invoice_date", "") or "",
        "total_amount": float(data.get("total_amount") or 0),
        "cgst": float(data.get("cgst") or 0),
        "sgst": float(data.get("sgst") or 0),
        "igst": float(data.get("igst") or 0),
        # V2.2 native
        "items": validated_items,
        # Legacy (back-compat with server.py)
        "line_items": legacy_lines,
        "confidence_score": avg_combined,
        "llm_confidence": avg_llm,
        "heuristic_confidence": avg_heur,
        "provider": provider,
        "model": model,
        "_raw": cleaned[:1500],
    }


async def parse_photo_order(file_path: str, mime_type: str) -> dict:
    """Run OCR on a photo of an order sheet. Returns {items: [{sku, description, qty}], provider, model}."""
    provider, model = _get_provider_model()
    try:
        chat = _build_chat(f"photo-order-{os.path.basename(file_path)}", PHOTO_ORDER_PROMPT)
        attachment = FileContentWithMimeType(file_path=file_path, mime_type=mime_type)
        msg = UserMessage(
            text="Extract every order line as JSON exactly as specified.",
            file_contents=[attachment],
        )
        response = await chat.send_message(msg)
        text = response if isinstance(response, str) else str(response)
        cleaned = _clean_json_text(text)
        data = json.loads(cleaned)
    except json.JSONDecodeError as e:
        logger.warning("Photo OCR JSON decode failed: %s", e)
        return {"items": [], "provider": provider, "model": model, "_error": f"JSON parse error: {str(e)[:140]}"}
    except Exception as e:
        logger.exception("Photo OCR failed")
        return {"items": [], "provider": provider, "model": model, "_error": f"OCR error: {str(e)[:140]}"}

    raw_items = data.get("items") or []
    items: list[dict] = []
    for it in raw_items:
        if not isinstance(it, dict):
            continue
        try:
            qty = int(float(it.get("qty") or 0))
        except Exception:
            qty = 0
        if qty <= 0:
            qty = 1
        items.append({
            "sku": (it.get("sku") or "").strip(),
            "description": (it.get("description") or "").strip(),
            "qty": qty,
        })
    return {"items": items, "provider": provider, "model": model}


def _empty_response(reason: str, provider: str, model: str) -> dict:
    return {
        "vendor_name": "",
        "invoice_number": "",
        "invoice_date": "",
        "total_amount": 0.0,
        "cgst": 0.0,
        "sgst": 0.0,
        "igst": 0.0,
        "items": [],
        "line_items": [],
        "confidence_score": 0.0,
        "llm_confidence": 0.0,
        "heuristic_confidence": 0.0,
        "provider": provider,
        "model": model,
        "_error": reason,
    }
