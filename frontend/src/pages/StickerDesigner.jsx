import React, { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import * as fabric from "fabric";
import jsPDF from "jspdf";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import {
  FloppyDisk, ArrowCounterClockwise, ArrowClockwise, Copy, Trash, Printer,
  TextT, QrCode, Barcode, Image as ImageIcon, Square, Plus, MagnifyingGlassPlus, MagnifyingGlassMinus,
  ArrowLeft, AlignLeft, AlignCenterHorizontal, AlignRight, StackSimple, Eye,
} from "@phosphor-icons/react";
import {
  STICKER_FIELDS, generateBarcodeDataURL, bindCanvasJson, loadPreviewData, mmToPx,
} from "@/lib/stickerEngine";

const STICKER_TYPES = [
  { value: "small_product", label: "Small Product Sticker" },
  { value: "large_product", label: "Large Product Sticker" },
  { value: "dealer", label: "Dealer Sticker" },
  { value: "custom", label: "Custom" },
  { value: "barcode_label", label: "Barcode Label" },
  { value: "qr_label", label: "QR Label" },
];

const BARCODE_FORMATS = [
  { value: "code128", label: "Code 128 (default)" },
  { value: "ean13", label: "EAN-13" },
  { value: "ean8", label: "EAN-8" },
  { value: "upca", label: "UPC-A" },
  { value: "upce", label: "UPC-E" },
  { value: "code39", label: "Code 39" },
];

/**
 * Sticker Designer
 *
 * Single-page Canva-style designer built on fabric.js v6. Persists fabric's
 * native JSON to the backend so the file format remains fully introspectable
 * (and could later power a server-side ZPL/EPL emitter without touching the
 * UI). Custom per-object metadata (binding key, barcode kind/format) lives
 * on the `data` namespace which fabric preserves through serialise/deserialise.
 */
export default function StickerDesigner() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const canvasElRef = useRef(null);
  const fabricRef = useRef(null);
  const containerRef = useRef(null);

  const [tpl, setTpl] = useState({
    name: "",
    sticker_type: searchParams.get("type") || "custom",
    width_mm: 50,
    height_mm: 30,
    background_color: "#ffffff",
    dpi: 203,
  });
  const [previewData, setPreviewData] = useState(null);
  const [selectedObj, setSelectedObj] = useState(null);
  const [layers, setLayers] = useState([]);
  const [zoom, setZoom] = useState(2.5); // designers want generous magnification
  const [hist, setHist] = useState({ stack: [], idx: -1 });
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!!id);
  const [showGrid, setShowGrid] = useState(true);
  const [previewMode, setPreviewMode] = useState(false);
  const histRef = useRef(hist);  // ref so save handlers see current value without re-binding
  histRef.current = hist;
  const isLoadingRef = useRef(false); // suppress history during programmatic loads

  // --- Initial fabric setup ------------------------------------------------
  useEffect(() => {
    if (!canvasElRef.current) return;
    const w = mmToPx(tpl.width_mm) * zoom;
    const h = mmToPx(tpl.height_mm) * zoom;
    const c = new fabric.Canvas(canvasElRef.current, {
      width: w,
      height: h,
      backgroundColor: tpl.background_color || "#ffffff",
      preserveObjectStacking: true,
      selection: true,
    });
    // Snap to integer pixels — nicer for sticker layouts.
    c.on("object:moving", (e) => {
      e.target.set({ left: Math.round(e.target.left), top: Math.round(e.target.top) });
    });
    c.on("selection:created", (e) => setSelectedObj(e.selected?.[0] || null));
    c.on("selection:updated", (e) => setSelectedObj(e.selected?.[0] || null));
    c.on("selection:cleared", () => setSelectedObj(null));
    const refreshLayers = () => setLayers([...c.getObjects()].reverse());
    c.on("object:added", refreshLayers);
    c.on("object:removed", refreshLayers);
    c.on("object:modified", () => { pushHistory(); refreshLayers(); });
    fabricRef.current = c;
    refreshLayers();

    // Initial empty history snapshot
    pushHistory();

    return () => { c.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Re-apply canvas size on dimension changes ---------------------------
  useEffect(() => {
    if (!fabricRef.current) return;
    fabricRef.current.setDimensions({
      width: mmToPx(tpl.width_mm) * zoom,
      height: mmToPx(tpl.height_mm) * zoom,
    });
    fabricRef.current.setZoom(zoom);
    fabricRef.current.backgroundColor = tpl.background_color || "#ffffff";
    fabricRef.current.requestRenderAll();
  }, [tpl.width_mm, tpl.height_mm, zoom, tpl.background_color]);

  // --- Load existing template / preview data -------------------------------
  useEffect(() => {
    loadPreviewData(api).then(setPreviewData).catch(() => {});
  }, []);

  useEffect(() => {
    if (!id || !fabricRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get(`/sticker-templates/${id}`);
        if (cancelled) return;
        setTpl({
          name: r.data.name,
          sticker_type: r.data.sticker_type,
          width_mm: r.data.width_mm,
          height_mm: r.data.height_mm,
          background_color: r.data.background_color || "#ffffff",
          dpi: r.data.dpi || 203,
        });
        isLoadingRef.current = true;
        if (r.data.canvas_json && Array.isArray(r.data.canvas_json.objects)) {
          await fabricRef.current.loadFromJSON(r.data.canvas_json);
          fabricRef.current.renderAll();
        }
        isLoadingRef.current = false;
        pushHistory(); // reset stack with the loaded state
      } catch (e) {
        toast.error("Could not load template");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // --- History (undo/redo) -------------------------------------------------
  const pushHistory = useCallback(() => {
    if (isLoadingRef.current || !fabricRef.current) return;
    const snap = fabricRef.current.toJSON(["data"]);
    setHist((h) => {
      const stack = [...h.stack.slice(0, h.idx + 1), snap].slice(-60);
      return { stack, idx: stack.length - 1 };
    });
  }, []);

  const undo = async () => {
    const h = histRef.current;
    if (h.idx <= 0) return;
    const target = h.stack[h.idx - 1];
    isLoadingRef.current = true;
    await fabricRef.current.loadFromJSON(target);
    fabricRef.current.renderAll();
    isLoadingRef.current = false;
    setHist((cur) => ({ ...cur, idx: cur.idx - 1 }));
  };
  const redo = async () => {
    const h = histRef.current;
    if (h.idx >= h.stack.length - 1) return;
    const target = h.stack[h.idx + 1];
    isLoadingRef.current = true;
    await fabricRef.current.loadFromJSON(target);
    fabricRef.current.renderAll();
    isLoadingRef.current = false;
    setHist((cur) => ({ ...cur, idx: cur.idx + 1 }));
  };

  // --- Object factories ----------------------------------------------------
  const addObject = (obj) => {
    const c = fabricRef.current;
    c.add(obj);
    c.setActiveObject(obj);
    c.requestRenderAll();
    pushHistory();
  };
  const addText = () => addObject(new fabric.Textbox("Text", {
    left: 20, top: 20, fontSize: 14, fill: "#111", fontFamily: "Inter", width: 120,
    data: {},
  }));
  const addField = (fieldKey) => {
    const meta = STICKER_FIELDS.find((f) => f.key === fieldKey);
    addObject(new fabric.Textbox(`{{${fieldKey}}}`, {
      left: 20, top: 20, fontSize: 14, fill: "#111", fontFamily: "Inter", width: 160,
      data: { binding: fieldKey, fieldLabel: meta?.label || fieldKey },
    }));
  };
  const addRect = () => addObject(new fabric.Rect({
    left: 20, top: 20, width: 80, height: 30, fill: "transparent",
    stroke: "#111", strokeWidth: 1, data: {},
  }));
  const addBarcode = async (format = "code128", valueKey = "barcode_value") => {
    const seed = previewData?.[valueKey] || "1234567890123";
    const url = await generateBarcodeDataURL(seed, { format });
    const img = await fabric.FabricImage.fromURL(url, { crossOrigin: "anonymous" });
    img.set({ left: 20, top: 20, scaleX: 0.6, scaleY: 0.6,
      data: { kind: "barcode", format, value_key: valueKey } });
    addObject(img);
  };
  const addQR = async (valueKey = "qr_value") => {
    const seed = previewData?.[valueKey] || "https://example.com";
    const url = await generateBarcodeDataURL(seed, { format: "qrcode" });
    const img = await fabric.FabricImage.fromURL(url, { crossOrigin: "anonymous" });
    img.set({ left: 20, top: 20, scaleX: 0.4, scaleY: 0.4,
      data: { kind: "qr", format: "qrcode", value_key: valueKey } });
    addObject(img);
  };
  const addImageFromUrl = (url) => {
    if (!url) return;
    fabric.FabricImage.fromURL(url, { crossOrigin: "anonymous" }).then((img) => {
      img.set({ left: 20, top: 20, scaleX: 0.5, scaleY: 0.5, data: { kind: "logo" } });
      addObject(img);
    }).catch(() => toast.error("Could not load image"));
  };
  const onImageFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => addImageFromUrl(e.target.result);
    reader.readAsDataURL(file);
  };

  // --- Selection actions ---------------------------------------------------
  const removeSelected = () => {
    const c = fabricRef.current;
    const objs = c.getActiveObjects();
    objs.forEach((o) => c.remove(o));
    c.discardActiveObject();
    c.requestRenderAll();
    pushHistory();
  };
  const duplicateSelected = async () => {
    const c = fabricRef.current;
    const a = c.getActiveObject();
    if (!a) return;
    const cloned = await a.clone(["data"]);
    cloned.set({ left: (a.left || 0) + 10, top: (a.top || 0) + 10 });
    c.add(cloned);
    c.setActiveObject(cloned);
    c.requestRenderAll();
    pushHistory();
  };
  const alignSelected = (mode) => {
    const c = fabricRef.current;
    const a = c.getActiveObject();
    if (!a) return;
    const w = c.getWidth() / c.getZoom();
    if (mode === "left") a.set({ left: 0 });
    if (mode === "center") a.set({ left: (w - a.getScaledWidth()) / 2 });
    if (mode === "right") a.set({ left: w - a.getScaledWidth() });
    a.setCoords();
    c.requestRenderAll();
    pushHistory();
  };
  const bringForward = () => { const a = fabricRef.current.getActiveObject(); if (a) { fabricRef.current.bringObjectForward(a); pushHistory(); } };
  const sendBackward = () => { const a = fabricRef.current.getActiveObject(); if (a) { fabricRef.current.sendObjectBackwards(a); pushHistory(); } };

  const updateSelected = (patch) => {
    const a = fabricRef.current.getActiveObject();
    if (!a) return;
    a.set(patch);
    a.setCoords();
    fabricRef.current.requestRenderAll();
    setSelectedObj({ ...a });
  };

  // --- Preview / print -----------------------------------------------------
  const togglePreview = async () => {
    if (!previewMode) {
      const snap = fabricRef.current.toJSON(["data"]);
      const hydrated = await bindCanvasJson(snap, previewData || {});
      isLoadingRef.current = true;
      await fabricRef.current.loadFromJSON(hydrated);
      fabricRef.current.renderAll();
      isLoadingRef.current = false;
      setPreviewMode(true);
    } else {
      // Restore from latest authoritative history entry
      const cur = histRef.current.stack[histRef.current.idx];
      if (cur) {
        isLoadingRef.current = true;
        await fabricRef.current.loadFromJSON(cur);
        fabricRef.current.renderAll();
        isLoadingRef.current = false;
      }
      setPreviewMode(false);
    }
  };

  const exportSampleAsPdf = async () => {
    const snap = fabricRef.current.toJSON(["data"]);
    const hydrated = await bindCanvasJson(snap, previewData || {});
    // Render hydrated JSON into an offscreen fabric canvas at 1:1 mm scale (96dpi).
    const off = document.createElement("canvas");
    off.width = mmToPx(tpl.width_mm);
    off.height = mmToPx(tpl.height_mm);
    const tmp = new fabric.StaticCanvas(off);
    tmp.setDimensions({ width: off.width, height: off.height });
    tmp.setZoom(1);
    tmp.backgroundColor = tpl.background_color || "#ffffff";
    await tmp.loadFromJSON(hydrated);
    tmp.renderAll();
    const dataUrl = tmp.toDataURL({ format: "png" });
    const pdf = new jsPDF({ unit: "mm", format: [tpl.width_mm, tpl.height_mm], orientation: tpl.width_mm > tpl.height_mm ? "l" : "p" });
    pdf.addImage(dataUrl, "PNG", 0, 0, tpl.width_mm, tpl.height_mm);
    pdf.save(`${(tpl.name || "sticker").replace(/[^A-Za-z0-9._-]+/g, "_")}-preview.pdf`);
    tmp.dispose();
  };

  // --- Save ---------------------------------------------------------------
  const save = async (asCopy = false) => {
    if (!tpl.name) { toast.error("Give the template a name"); return; }
    setSaving(true);
    try {
      const canvas_json = fabricRef.current.toJSON(["data"]);
      const fields_used = [];
      (canvas_json.objects || []).forEach((o) => {
        if (o?.data?.binding) fields_used.push(o.data.binding);
        if (o?.data?.value_key) fields_used.push(o.data.value_key);
      });
      const body = {
        name: tpl.name,
        sticker_type: tpl.sticker_type,
        description: "",
        width_mm: Number(tpl.width_mm) || 50,
        height_mm: Number(tpl.height_mm) || 30,
        dpi: Number(tpl.dpi) || 203,
        background_color: tpl.background_color || "#ffffff",
        canvas_json,
        thumbnail: "",
        fields_used: Array.from(new Set(fields_used)),
      };
      let saved;
      if (id && !asCopy) {
        const r = await api.put(`/sticker-templates/${id}`, body);
        saved = r.data;
        toast.success("Template saved");
      } else {
        const r = await api.post("/sticker-templates", body);
        saved = r.data;
        toast.success("Template created");
        navigate(`/stickers/designer/${saved.id}`, { replace: true });
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // --- Render -------------------------------------------------------------
  const isText = selectedObj && ["i-text", "text", "textbox"].includes(selectedObj.type);
  const isImage = selectedObj && selectedObj.type === "image";

  return (
    <div className="space-y-4" data-testid="sticker-designer">
      <div className="flex items-center justify-between gap-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/stickers")}><ArrowLeft size={14} className="mr-1" /> Templates</Button>
        <div className="flex items-center gap-2">
          <Input
            value={tpl.name}
            onChange={(e) => setTpl({ ...tpl, name: e.target.value })}
            placeholder="Template name…"
            className="w-64"
            data-testid="tpl-name"
          />
          <Select value={tpl.sticker_type} onValueChange={(v) => setTpl({ ...tpl, sticker_type: v })}>
            <SelectTrigger className="w-52" data-testid="tpl-type"><SelectValue /></SelectTrigger>
            <SelectContent>
              {STICKER_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input type="number" value={tpl.width_mm}
            onChange={(e) => setTpl({ ...tpl, width_mm: Number(e.target.value) || 1 })}
            className="w-20" title="Width (mm)" data-testid="tpl-width-mm" />
          <span className="text-muted-foreground text-xs">×</span>
          <Input type="number" value={tpl.height_mm}
            onChange={(e) => setTpl({ ...tpl, height_mm: Number(e.target.value) || 1 })}
            className="w-20" title="Height (mm)" data-testid="tpl-height-mm" />
          <span className="text-[10px] text-muted-foreground">mm</span>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={undo} title="Undo" data-testid="undo-btn"><ArrowCounterClockwise size={14} /></Button>
          <Button size="sm" variant="outline" onClick={redo} title="Redo" data-testid="redo-btn"><ArrowClockwise size={14} /></Button>
          <Button size="sm" variant="outline" onClick={togglePreview} data-testid="preview-btn"><Eye size={14} className="mr-1" /> {previewMode ? "Edit" : "Preview"}</Button>
          <Button size="sm" variant="outline" onClick={exportSampleAsPdf} data-testid="export-pdf-btn"><Printer size={14} className="mr-1" /> PDF</Button>
          <Button size="sm" variant="outline" onClick={() => save(true)} disabled={saving} data-testid="save-as-btn">Save As</Button>
          <Button size="sm" onClick={() => save(false)} disabled={saving} data-testid="save-btn"><FloppyDisk size={14} className="mr-1" /> Save</Button>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-3" style={{ minHeight: "70vh" }}>
        {/* Left palette */}
        <div className="col-span-2 border border-border rounded-md bg-card p-2 space-y-3 text-xs overflow-y-auto" style={{ maxHeight: "75vh" }}>
          <Section title="Add">
            <PaletteBtn icon={TextT} label="Text" onClick={addText} testId="add-text" />
            <PaletteBtn icon={Barcode} label="Barcode" onClick={() => addBarcode()} testId="add-barcode" />
            <PaletteBtn icon={QrCode} label="QR Code" onClick={() => addQR()} testId="add-qr" />
            <PaletteBtn icon={Square} label="Rectangle" onClick={addRect} testId="add-rect" />
            <label className="block">
              <input type="file" accept="image/*" hidden onChange={(e) => onImageFile(e.target.files?.[0])} data-testid="add-image-input" />
              <span className="flex items-center gap-2 px-2 py-1.5 rounded border border-border hover:bg-muted cursor-pointer">
                <ImageIcon size={14} /> Image
              </span>
            </label>
          </Section>

          <Section title="Insert Field">
            {STICKER_FIELDS.map((f) => (
              <button key={f.key} onClick={() => addField(f.key)} title={`{{${f.key}}} — sample: ${f.example}`}
                className="w-full text-left text-[11px] px-2 py-1 rounded hover:bg-muted truncate" data-testid={`add-field-${f.key}`}>
                {f.label}
              </button>
            ))}
          </Section>
        </div>

        {/* Canvas area */}
        <div className="col-span-7 border border-border rounded-md bg-muted/20 p-4 flex flex-col" ref={containerRef}>
          <div className="flex items-center justify-between mb-2 text-xs">
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" onClick={() => setZoom(Math.max(0.5, zoom - 0.5))} data-testid="zoom-out"><MagnifyingGlassMinus size={12} /></Button>
              <span className="px-2 tabular-nums">{Math.round(zoom * 100)}%</span>
              <Button size="sm" variant="outline" onClick={() => setZoom(Math.min(8, zoom + 0.5))} data-testid="zoom-in"><MagnifyingGlassPlus size={12} /></Button>
              <label className="flex items-center gap-1 ml-3 text-muted-foreground">
                <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> grid
              </label>
            </div>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" onClick={() => alignSelected("left")} title="Align left" data-testid="align-left"><AlignLeft size={12} /></Button>
              <Button size="sm" variant="outline" onClick={() => alignSelected("center")} title="Align center horizontally" data-testid="align-center"><AlignCenterHorizontal size={12} /></Button>
              <Button size="sm" variant="outline" onClick={() => alignSelected("right")} title="Align right" data-testid="align-right"><AlignRight size={12} /></Button>
              <Button size="sm" variant="outline" onClick={duplicateSelected} title="Duplicate" data-testid="duplicate-btn"><Copy size={12} /></Button>
              <Button size="sm" variant="outline" onClick={removeSelected} title="Delete" data-testid="remove-btn"><Trash size={12} /></Button>
              <Button size="sm" variant="outline" onClick={bringForward} title="Bring forward" data-testid="layer-up"><StackSimple size={12} /></Button>
            </div>
          </div>
          <div
            className="flex-1 overflow-auto bg-background rounded border border-border flex items-start justify-center p-6"
            style={{
              backgroundImage: showGrid
                ? "repeating-linear-gradient(0deg, transparent, transparent 9px, rgba(127,127,127,0.12) 9px, rgba(127,127,127,0.12) 10px), repeating-linear-gradient(90deg, transparent, transparent 9px, rgba(127,127,127,0.12) 9px, rgba(127,127,127,0.12) 10px)"
                : undefined,
            }}
          >
            <canvas ref={canvasElRef} data-testid="designer-canvas" />
          </div>
          {loading && <div className="text-xs text-muted-foreground mt-2">Loading template…</div>}
        </div>

        {/* Right inspector */}
        <div className="col-span-3 border border-border rounded-md bg-card p-3 space-y-3 text-xs overflow-y-auto" style={{ maxHeight: "75vh" }}>
          <Section title="Inspector">
            {!selectedObj && <div className="text-muted-foreground">Select an object to edit its properties.</div>}
            {selectedObj && (
              <div className="space-y-2">
                <Row label="Type"><span className="font-mono text-[10px]">{selectedObj.type}{selectedObj.data?.binding ? ` · {{${selectedObj.data.binding}}}` : ""}{selectedObj.data?.kind ? ` · ${selectedObj.data.kind}` : ""}</span></Row>
                <Row label="X"><Input className="h-7" type="number" value={Math.round(selectedObj.left || 0)} onChange={(e) => updateSelected({ left: Number(e.target.value) })} data-testid="inspect-x" /></Row>
                <Row label="Y"><Input className="h-7" type="number" value={Math.round(selectedObj.top || 0)} onChange={(e) => updateSelected({ top: Number(e.target.value) })} data-testid="inspect-y" /></Row>
                <Row label="Rot"><Input className="h-7" type="number" value={Math.round(selectedObj.angle || 0)} onChange={(e) => updateSelected({ angle: Number(e.target.value) })} data-testid="inspect-rot" /></Row>
                {isText && (
                  <>
                    <Row label="Text"><Input className="h-7" value={selectedObj.text || ""} onChange={(e) => updateSelected({ text: e.target.value })} data-testid="inspect-text" /></Row>
                    <Row label="Size"><Input className="h-7" type="number" value={selectedObj.fontSize || 14} onChange={(e) => updateSelected({ fontSize: Number(e.target.value) || 8 })} data-testid="inspect-fontsize" /></Row>
                    <Row label="Bold">
                      <Button size="sm" variant={selectedObj.fontWeight === "bold" ? "default" : "outline"}
                        onClick={() => updateSelected({ fontWeight: selectedObj.fontWeight === "bold" ? "normal" : "bold" })}
                        className="h-7 px-2" data-testid="inspect-bold">B</Button>
                    </Row>
                    <Row label="Align">
                      <Select value={selectedObj.textAlign || "left"} onValueChange={(v) => updateSelected({ textAlign: v })}>
                        <SelectTrigger className="h-7"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="left">Left</SelectItem>
                          <SelectItem value="center">Center</SelectItem>
                          <SelectItem value="right">Right</SelectItem>
                        </SelectContent>
                      </Select>
                    </Row>
                    <Row label="Color"><Input className="h-7" type="color" value={selectedObj.fill || "#111111"} onChange={(e) => updateSelected({ fill: e.target.value })} /></Row>
                  </>
                )}
                {isImage && selectedObj.data?.kind === "barcode" && (
                  <Row label="Format">
                    <Select value={selectedObj.data?.format || "code128"} onValueChange={(v) => {
                      selectedObj.data = { ...selectedObj.data, format: v };
                      regenBarcodeOn(selectedObj, previewData);
                      fabricRef.current.requestRenderAll(); pushHistory();
                    }}>
                      <SelectTrigger className="h-7" data-testid="inspect-barcode-format"><SelectValue /></SelectTrigger>
                      <SelectContent>{BARCODE_FORMATS.map((b) => <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </Row>
                )}
                {(isImage && (selectedObj.data?.kind === "barcode" || selectedObj.data?.kind === "qr")) && (
                  <Row label="Bind to">
                    <Select value={selectedObj.data?.value_key || (selectedObj.data?.kind === "qr" ? "qr_value" : "barcode_value")}
                      onValueChange={(v) => {
                        selectedObj.data = { ...selectedObj.data, value_key: v };
                        regenBarcodeOn(selectedObj, previewData);
                        fabricRef.current.requestRenderAll(); pushHistory();
                      }}>
                      <SelectTrigger className="h-7" data-testid="inspect-bind"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {STICKER_FIELDS.map((f) => <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </Row>
                )}
              </div>
            )}
          </Section>

          <Section title={`Layers (${layers.length})`}>
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {layers.map((o, i) => (
                <button key={i} onClick={() => { fabricRef.current.setActiveObject(o); fabricRef.current.requestRenderAll(); }}
                  className={`flex items-center justify-between w-full text-left px-2 py-1 rounded text-[11px] hover:bg-muted ${o === selectedObj ? "bg-muted" : ""}`}
                  data-testid={`layer-${i}`}
                >
                  <span className="truncate">
                    {o.type === "textbox" || o.type === "i-text" || o.type === "text"
                      ? `T: ${(o.text || "").slice(0, 30)}`
                      : (o.data?.kind || o.type)}
                  </span>
                  <span className="text-muted-foreground text-[9px]">#{layers.length - i}</span>
                </button>
              ))}
              {layers.length === 0 && <div className="text-muted-foreground">No objects yet.</div>}
            </div>
          </Section>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={sendBackward} className="flex-1">Send Back</Button>
            <Button variant="outline" size="sm" onClick={bringForward} className="flex-1">Bring Forward</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

async function regenBarcodeOn(obj, previewData) {
  const k = obj.data?.kind;
  const valueKey = obj.data?.value_key || (k === "qr" ? "qr_value" : "barcode_value");
  const val = previewData ? previewData[valueKey] : "";
  const fmt = obj.data?.format || (k === "qr" ? "qrcode" : "code128");
  try {
    const url = await generateBarcodeDataURL(val, { format: fmt });
    obj.setSrc(url, { crossOrigin: "anonymous" });
  } catch (_) { /* keep prior */ }
}

function Section({ title, children }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}
function Row({ label, children }) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground w-12 shrink-0">{label}</span>
      <span className="flex-1 min-w-0">{children}</span>
    </label>
  );
}
function PaletteBtn({ icon: Icon, label, onClick, testId }) {
  return (
    <button onClick={onClick} className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded border border-border hover:bg-muted" data-testid={testId}>
      <Icon size={14} /> {label}
    </button>
  );
}
