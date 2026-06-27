/**
 * Sticker Engine — shared helpers used by the designer + the batch print page.
 *
 * 1. interpolate({{placeholders}}) against a data bag.
 * 2. generate barcode / QR PNG data URLs via bwip-js (single library for
 *    Code128, EAN13, UPC, QR, and many more — Phase 2 promise).
 * 3. resolve a canvas_json + data bag → a hydrated fabric.js canvas JSON
 *    where text fields are substituted and barcode/QR objects have their
 *    rendered image set.
 * 4. compute physical dimensions (mm ↔ px) for both screen and print.
 */
import bwipjs from "bwip-js";

/** Replace {{key}} placeholders in a string against a data bag.
 *  Unknown keys are left as-is (helps the designer see what's bound). */
export function interpolate(template, data) {
  if (typeof template !== "string") return template;
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key) => {
    if (data && Object.prototype.hasOwnProperty.call(data, key)) {
      const v = data[key];
      return v === undefined || v === null ? "" : String(v);
    }
    return `{{${key}}}`;
  });
}

/** Format mapping for bwip-js. Anything not listed here is passed through
 *  verbatim, which lets the user pick exotic formats later without code edits. */
const BWIP_FORMAT_MAP = {
  code128: "code128",
  ean13: "ean13",
  ean8: "ean8",
  upca: "upca",
  upce: "upce",
  qr: "qrcode",
  qrcode: "qrcode",
  datamatrix: "datamatrix",
  pdf417: "pdf417",
  code39: "code39",
};

/**
 * Render a barcode / QR using bwip-js on an offscreen canvas and return a
 * PNG data URL. Returns a fallback grey-rect data URL on error so the layout
 * never breaks during designing.
 *
 * @param {string} text     value to encode
 * @param {object} opts
 *   - format   bcid (code128 | ean13 | upc | qr ...)
 *   - scale    pixel scale (default 3)
 *   - height   bar height in mm (1D only) (default 10)
 *   - includetext  whether to show human readable text (default true for 1D, false for QR)
 *   - paddingwidth/-height
 */
export async function generateBarcodeDataURL(text, opts = {}) {
  const fmt = BWIP_FORMAT_MAP[(opts.format || "code128").toLowerCase()] || opts.format || "code128";
  const value = (text === undefined || text === null || text === "") ? " " : String(text);
  const isQRLike = ["qrcode", "datamatrix", "pdf417"].includes(fmt);
  const canvas = document.createElement("canvas");
  try {
    bwipjs.toCanvas(canvas, {
      bcid: fmt,
      text: value,
      scale: opts.scale ?? 3,
      height: opts.height ?? (isQRLike ? 0 : 10),
      includetext: opts.includetext ?? !isQRLike,
      textxalign: "center",
      paddingwidth: opts.paddingwidth ?? 0,
      paddingheight: opts.paddingheight ?? 0,
      backgroundcolor: "FFFFFF",
    });
    return canvas.toDataURL("image/png");
  } catch (e) {
    // Fallback — render a tiny placeholder so the canvas doesn't crash.
    const c = document.createElement("canvas");
    c.width = 120;
    c.height = 60;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#eee";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.fillText("invalid barcode", 12, 34);
    return c.toDataURL("image/png");
  }
}

/** mm → screen pixels at fabric's default 96 DPI (what the canvas uses). */
export const mmToPx = (mm) => Math.round((Number(mm) || 0) * (96 / 25.4));
/** Screen pixels → mm (inverse of the above). */
export const pxToMm = (px) => Math.round(((Number(px) || 0) * (25.4 / 96)) * 100) / 100;

/**
 * Walk a fabric canvas JSON and apply data bindings, returning a NEW copy.
 *  - text objects: interpolate `text` field.
 *  - text objects whose `data.binding` is set to a key in `data`: replace text entirely.
 *  - image objects whose `data.kind` is `barcode` or `qr`: regenerate the
 *    image's src using bwip-js against `data[data.value_key]` (or `data.barcode_value`).
 *
 * Returns a Promise because barcode generation is async.
 */
export async function bindCanvasJson(canvasJson, data) {
  if (!canvasJson || !Array.isArray(canvasJson.objects)) {
    return canvasJson || { version: "6", objects: [] };
  }
  // Deep-clone (objects only contain primitives + arrays).
  const next = JSON.parse(JSON.stringify(canvasJson));
  for (const obj of next.objects) {
    if (!obj) continue;
    // Text objects
    if (obj.type === "i-text" || obj.type === "text" || obj.type === "textbox") {
      const bindingKey = obj.data && obj.data.binding;
      if (bindingKey && data && Object.prototype.hasOwnProperty.call(data, bindingKey)) {
        obj.text = String(data[bindingKey] ?? "");
      } else if (typeof obj.text === "string") {
        obj.text = interpolate(obj.text, data);
      }
    }
    // Barcode / QR objects (stored as type 'image' with data.kind)
    if (obj.type === "image" && obj.data) {
      const k = obj.data.kind;
      if (k === "barcode" || k === "qr") {
        const valueKey = obj.data.value_key || (k === "qr" ? "qr_value" : "barcode_value");
        const value = data ? data[valueKey] : "";
        const fmt = obj.data.format || (k === "qr" ? "qrcode" : "code128");
        try {
          obj.src = await generateBarcodeDataURL(value, { format: fmt });
        } catch (_) { /* keep prior src on failure */ }
      }
    }
  }
  return next;
}

/** The complete list of {{placeholder}} keys the engine knows about. Used
 *  by the designer to populate the 'Insert Field' menu and the AutoFill
 *  preview. Keeping it as data means the engine stays config-driven. */
export const STICKER_FIELDS = [
  { key: "sku", label: "SKU", example: "SPK-BAJ-001" },
  { key: "name", label: "Product Name", example: "Bajaj Pulsar Spark Plug" },
  { key: "brand", label: "Brand", example: "Bajaj" },
  { key: "category", label: "Category", example: "Engine Parts" },
  { key: "hsn", label: "HSN", example: "8708" },
  { key: "vehicle_compatibility", label: "Vehicle Compatibility", example: "Pulsar 150" },
  { key: "mrp", label: "MRP", example: "₹380" },
  { key: "selling_price", label: "Selling Price", example: "₹320" },
  { key: "franchise_price", label: "Franchise Price", example: "₹300" },
  { key: "landing_price", label: "Cost Price", example: "₹250" },
  { key: "quantity", label: "Quantity", example: "12" },
  { key: "batch_number", label: "Batch Number", example: "B-20260627" },
  { key: "mfg_date", label: "Mfg Date", example: "2026-06-01" },
  { key: "exp_date", label: "Exp Date", example: "2028-06-01" },
  { key: "company_name", label: "Company Name", example: "Servall" },
  { key: "company_address", label: "Company Address", example: "Bengaluru" },
  { key: "company_gstin", label: "Company GSTIN", example: "29AAAAA0000A1Z5" },
  { key: "dealer_name", label: "Dealer Name", example: "—" },
  { key: "custom_footer", label: "Custom Footer", example: "Thank you" },
  { key: "today", label: "Today's Date", example: "2026-06-27" },
];

/** Convenience — load preview-data from backend. */
export async function loadPreviewData(api, productId = null) {
  const params = productId ? `?product_id=${encodeURIComponent(productId)}` : "";
  const r = await api.get(`/sticker-templates/preview-data${params}`);
  return r.data;
}
