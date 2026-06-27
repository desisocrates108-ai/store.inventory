import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import * as fabric from "fabric";
import jsPDF from "jspdf";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { ArrowLeft, Printer, FilePdf, Trash, Plus, MagnifyingGlass } from "@phosphor-icons/react";
import { bindCanvasJson, mmToPx } from "@/lib/stickerEngine";

/**
 * Sticker Batch Print
 *
 * Workflow:
 *   1. Pick a template.
 *   2. Pick products. Choose qty strategy: 1 each / Inventory qty / Custom.
 *   3. Click Generate → renders each product's hydrated sticker as a PNG via
 *      a hidden fabric.StaticCanvas, lays them out on an A4 page (or on the
 *      exact label dimensions for direct print), and shows a print-ready
 *      preview.
 *   4. Print uses `window.print()` against a print-only stylesheet (no driver
 *      lock-in). PDF export uses jsPDF.
 *   5. Every print job is recorded via POST /sticker-print-jobs (audit log).
 *
 * Future printer backends (Zebra ZPL etc.) can be added by emitting a
 * different output format from the same `stickerImages` array without
 * changing this UI.
 */
export default function StickerBatchPrint() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useState(params.get("template_id") || "");
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState([]); // {product_id, sku, name, qty}
  const [strategy, setStrategy] = useState("one_each");
  const [layout, setLayout] = useState("a4"); // a4 | label
  const [printerLabel, setPrinterLabel] = useState("");
  const [generating, setGenerating] = useState(false);
  const [renderedPages, setRenderedPages] = useState([]); // [{dataUrl, pageStickers: [{dataUrl, productLabel}]}]
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    api.get("/sticker-templates").then((r) => setTemplates(r.data));
    api.get("/products?limit=2000").then((r) => setProducts(r.data));
  }, []);

  const template = useMemo(() => templates.find((t) => t.id === templateId) || null, [templates, templateId]);

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return products.filter((p) =>
      !picked.some((pp) => pp.product_id === p.id) && (
        (p.sku || "").toLowerCase().includes(q) ||
        (p.name || "").toLowerCase().includes(q) ||
        (p.brand || "").toLowerCase().includes(q)
      ),
    ).slice(0, 10);
  }, [products, picked, search]);

  const addProduct = (p) => {
    setPicked([...picked, { product_id: p.id, sku: p.sku, name: p.name, qty: 1, stock: p.hub_stock || 0 }]);
    setSearch("");
  };
  const updateQty = (i, qty) => {
    const next = [...picked];
    next[i] = { ...next[i], qty: Math.max(1, Number(qty) || 1) };
    setPicked(next);
  };
  const removePicked = (i) => setPicked(picked.filter((_, idx) => idx !== i));

  const expandedItems = useMemo(() => {
    // Returns [{product_id, sku, name, copies}]
    return picked.map((p) => {
      let copies = 1;
      if (strategy === "inventory_qty") copies = Math.max(1, Number(p.stock) || 1);
      else if (strategy === "custom") copies = Math.max(1, Number(p.qty) || 1);
      return { ...p, copies };
    });
  }, [picked, strategy]);

  const totalStickers = expandedItems.reduce((s, p) => s + p.copies, 0);

  // --- Render hydrated stickers as PNG data URLs ---------------------------
  const renderStickerImages = async () => {
    if (!template) throw new Error("Pick a template first");
    if (expandedItems.length === 0) throw new Error("Add at least one product");
    const wPx = mmToPx(template.width_mm);
    const hPx = mmToPx(template.height_mm);
    const off = document.createElement("canvas");
    off.width = wPx;
    off.height = hPx;
    const sc = new fabric.StaticCanvas(off);
    sc.setDimensions({ width: wPx, height: hPx });
    sc.setZoom(1);
    sc.backgroundColor = template.background_color || "#ffffff";

    const out = []; // flat list of {dataUrl, productLabel}
    for (const item of expandedItems) {
      const r = await api.get(`/sticker-templates/preview-data?product_id=${item.product_id}`);
      const hydrated = await bindCanvasJson(template.canvas_json || { version: "6", objects: [] }, r.data);
      sc.clear();
      sc.backgroundColor = template.background_color || "#ffffff";
      await sc.loadFromJSON(hydrated);
      sc.renderAll();
      const url = sc.toDataURL({ format: "png" });
      for (let c = 0; c < item.copies; c++) {
        out.push({ dataUrl: url, productLabel: `${item.sku} · ${item.name}`, sku: item.sku });
      }
    }
    sc.dispose();
    return out;
  };

  // Build A4 layout pages or single-sticker pages.
  const buildPages = (stickerImages) => {
    if (!template) return [];
    if (layout === "label") {
      return stickerImages.map((s) => ({ stickers: [s], single: true }));
    }
    // A4: 210 × 297 mm with 10mm margin all around → usable 190 × 277.
    const pageW = 210, pageH = 297, margin = 10, gap = 2;
    const tw = Number(template.width_mm) || 50;
    const th = Number(template.height_mm) || 30;
    const cols = Math.max(1, Math.floor((pageW - 2 * margin + gap) / (tw + gap)));
    const rows = Math.max(1, Math.floor((pageH - 2 * margin + gap) / (th + gap)));
    const perPage = cols * rows;
    const pages = [];
    for (let i = 0; i < stickerImages.length; i += perPage) {
      pages.push({
        stickers: stickerImages.slice(i, i + perPage),
        cols, rows, tw, th, margin, gap, pageW, pageH,
        single: false,
      });
    }
    return pages;
  };

  const generate = async () => {
    setGenerating(true);
    try {
      const imgs = await renderStickerImages();
      const pages = buildPages(imgs);
      setRenderedPages(pages);
      toast.success(`Rendered ${imgs.length} stickers across ${pages.length} page(s)`);
    } catch (e) {
      toast.error(e?.message || "Render failed");
    } finally { setGenerating(false); }
  };

  const recordJob = async (outputFormat) => {
    if (!template) return;
    setRecording(true);
    try {
      await api.post("/sticker-print-jobs", {
        template_id: template.id,
        qty_strategy: strategy,
        output_format: outputFormat,
        printer_label: printerLabel,
        product_ids: picked.map((p) => p.product_id),
        total_stickers: totalStickers,
        notes: layout === "a4" ? "A4 sheet" : "single label",
      });
    } catch (_) { /* non-blocking */ }
    finally { setRecording(false); }
  };

  const doPrint = async () => {
    if (renderedPages.length === 0) {
      toast.error("Generate first");
      return;
    }
    await recordJob("html");
    window.print();
  };

  const doExportPdf = async () => {
    if (renderedPages.length === 0) {
      toast.error("Generate first");
      return;
    }
    const tw = Number(template.width_mm) || 50;
    const th = Number(template.height_mm) || 30;
    const pdf = layout === "label"
      ? new jsPDF({ unit: "mm", format: [tw, th], orientation: tw > th ? "l" : "p" })
      : new jsPDF({ unit: "mm", format: "a4", orientation: "p" });
    renderedPages.forEach((page, pIdx) => {
      if (pIdx > 0) pdf.addPage();
      if (page.single) {
        pdf.addImage(page.stickers[0].dataUrl, "PNG", 0, 0, tw, th);
      } else {
        const { cols, margin, gap } = page;
        page.stickers.forEach((s, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          const x = margin + col * (tw + gap);
          const y = margin + row * (th + gap);
          pdf.addImage(s.dataUrl, "PNG", x, y, tw, th);
        });
      }
    });
    await recordJob("pdf");
    pdf.save(`stickers-${(template.name || "labels").replace(/[^A-Za-z0-9._-]+/g, "_")}.pdf`);
    toast.success("PDF downloaded");
  };

  return (
    <div className="space-y-6" data-testid="sticker-batch-print">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/stickers")}><ArrowLeft size={14} className="mr-1" /> Templates</Button>
          <div>
            <div className="text-xs uppercase tracking-[0.25em] text-muted-foreground">Label Engine</div>
            <h1 className="font-display text-2xl font-semibold tracking-tight">Batch Print</h1>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" onClick={generate} disabled={generating || !template || picked.length === 0} data-testid="generate-btn">
            <Plus size={14} className="mr-1" />{generating ? "Rendering…" : "Generate"}
          </Button>
          <Button variant="outline" onClick={doExportPdf} disabled={renderedPages.length === 0 || recording} data-testid="pdf-btn"><FilePdf size={14} className="mr-1" />PDF</Button>
          <Button onClick={doPrint} disabled={renderedPages.length === 0 || recording} data-testid="print-btn"><Printer size={14} className="mr-1" />Print</Button>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4 print:hidden">
        {/* Settings sidebar */}
        <div className="col-span-4 space-y-4">
          <div className="rounded-md border border-border bg-card p-4 space-y-3">
            <div>
              <Label>Template</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger data-testid="bp-template"><SelectValue placeholder="Pick a template…" /></SelectTrigger>
                <SelectContent>
                  {templates.map((t) => <SelectItem key={t.id} value={t.id}>{t.name} ({t.width_mm}×{t.height_mm}mm)</SelectItem>)}
                </SelectContent>
              </Select>
              {template && (
                <div className="text-[10px] text-muted-foreground mt-1">
                  {(template.canvas_json?.objects || []).length} objects · type {template.sticker_type}
                </div>
              )}
            </div>
            <div>
              <Label>Quantity Strategy</Label>
              <Select value={strategy} onValueChange={setStrategy}>
                <SelectTrigger data-testid="bp-strategy"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="one_each">1 sticker per product</SelectItem>
                  <SelectItem value="inventory_qty">Use inventory quantity</SelectItem>
                  <SelectItem value="custom">Custom quantity per product</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Page Layout</Label>
              <Select value={layout} onValueChange={setLayout}>
                <SelectTrigger data-testid="bp-layout"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="a4">A4 Sheet (grid)</SelectItem>
                  <SelectItem value="label">One sticker per page (thermal labels)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Printer / Device label</Label>
              <Input value={printerLabel} onChange={(e) => setPrinterLabel(e.target.value)} placeholder="e.g. Zebra ZD230 — Warehouse-A1" data-testid="bp-printer" />
              <div className="text-[10px] text-muted-foreground mt-1">Recorded in the audit log only.</div>
            </div>
          </div>
        </div>

        {/* Products */}
        <div className="col-span-8 space-y-3">
          <div className="rounded-md border border-border bg-card p-3 space-y-3">
            <Label>Add Products</Label>
            <div className="relative">
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search SKU, name, brand…" data-testid="bp-search" />
              {filteredProducts.length > 0 && (
                <div className="absolute z-10 left-0 right-0 top-[105%] bg-popover border border-border rounded shadow max-h-72 overflow-y-auto">
                  {filteredProducts.map((p) => (
                    <button key={p.id} onClick={() => addProduct(p)}
                      className="block w-full text-left px-3 py-2 hover:bg-muted text-sm border-b border-border last:border-b-0"
                      data-testid={`bp-add-${p.sku}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[10px] text-muted-foreground">{p.sku}</span>
                        <span className="text-[10px] text-muted-foreground">stock {p.hub_stock || 0}</span>
                      </div>
                      <div className="text-xs">{p.name}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {picked.length > 0 ? (
              <div className="rounded border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40">
                    <tr className="text-left text-[10px] uppercase text-muted-foreground">
                      <th className="px-2 py-2">SKU</th>
                      <th className="px-2 py-2">Item</th>
                      <th className="px-2 py-2 text-right">Hub Stock</th>
                      <th className="px-2 py-2 text-center">Qty</th>
                      <th className="px-2 py-2 text-right">Copies</th>
                      <th className="px-2 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {picked.map((p, i) => {
                      const copies = strategy === "inventory_qty" ? (p.stock || 1)
                        : strategy === "custom" ? p.qty : 1;
                      return (
                        <tr key={p.product_id} className="border-t border-border" data-testid={`bp-row-${p.sku}`}>
                          <td className="px-2 py-1.5 font-mono">{p.sku}</td>
                          <td className="px-2 py-1.5">{p.name}</td>
                          <td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums">{p.stock || 0}</td>
                          <td className="px-2 py-1.5 text-center">
                            <Input className="w-16 mx-auto h-7 text-center"
                              disabled={strategy !== "custom"}
                              value={p.qty} onChange={(e) => updateQty(i, e.target.value)} type="number" min={1}
                              data-testid={`bp-qty-${p.sku}`} />
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{copies}</td>
                          <td className="px-2 py-1.5 text-right">
                            <button onClick={() => removePicked(i)} className="p-1 rounded hover:bg-destructive/10 text-destructive" data-testid={`bp-remove-${p.sku}`}><Trash size={12} /></button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/40 border-t border-border font-medium">
                      <td colSpan={4} className="px-2 py-2 text-right">Total stickers</td>
                      <td className="px-2 py-2 text-right tabular-nums" data-testid="bp-total-stickers">{totalStickers}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              <div className="text-center py-8 text-xs text-muted-foreground border border-dashed border-border rounded">Use the search above to add products.</div>
            )}
          </div>
        </div>
      </div>

      {/* Print preview */}
      {renderedPages.length > 0 && (
        <div id="sticker-print-area" className="space-y-6" data-testid="print-area">
          {renderedPages.map((page, idx) => (
            <PagePreview key={idx} page={page} template={template} layout={layout} />
          ))}
        </div>
      )}

      {/* Print stylesheet — hide chrome, render only #sticker-print-area */}
      <style>{`
        @media print {
          @page { size: ${layout === "a4" ? "A4 portrait" : `${template?.width_mm || 50}mm ${template?.height_mm || 30}mm`}; margin: 0; }
          body * { visibility: hidden !important; }
          #sticker-print-area, #sticker-print-area * { visibility: visible !important; }
          #sticker-print-area { position: absolute; left: 0; top: 0; right: 0; }
          .page-break { page-break-after: always; }
        }
      `}</style>
    </div>
  );
}

function PagePreview({ page, template, layout }) {
  if (!template) return null;
  if (page.single) {
    return (
      <div className="page-break flex items-center justify-center bg-white border border-border rounded p-2">
        <img src={page.stickers[0].dataUrl} alt={page.stickers[0].productLabel}
          style={{ width: `${template.width_mm}mm`, height: `${template.height_mm}mm` }} />
      </div>
    );
  }
  const { cols, rows, tw, th, margin, gap, pageW, pageH, stickers } = page;
  return (
    <div className="page-break mx-auto bg-white border border-border" style={{ width: `${pageW}mm`, height: `${pageH}mm`, padding: `${margin}mm` }}>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, ${tw}mm)`, gap: `${gap}mm` }}>
        {stickers.map((s, i) => (
          <img key={i} src={s.dataUrl} alt={s.productLabel} style={{ width: `${tw}mm`, height: `${th}mm` }} />
        ))}
      </div>
    </div>
  );
}
