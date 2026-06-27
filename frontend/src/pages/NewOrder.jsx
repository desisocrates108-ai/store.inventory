import React, { useEffect, useRef, useState } from "react";
import api, { formatINR } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { ArrowLeft, Camera, FileXls, Keyboard, Plus, Trash, UploadSimple, CheckCircle } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";

export default function NewOrder() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [mode, setMode] = useState("choose"); // choose | system | photo | excel | starter_kit
  const [franchises, setFranchises] = useState([]);
  const [franchiseId, setFranchiseId] = useState("");
  const [priority, setPriority] = useState("routine");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [starterKit, setStarterKit] = useState(null); // {line_items, snapshot_version, default_margin_percent, franchise_name, tier_name}
  const [kitLoading, setKitLoading] = useState(false);

  useEffect(() => {
    api.get("/franchises").then((r) => {
      setFranchises(r.data);
      if (user?.role === "franchise_manager" && user?.franchise_id) {
        setFranchiseId(user.franchise_id);
      } else if (r.data.length === 1) {
        setFranchiseId(r.data[0].id);
      }
    });
  }, [user]);

  // Auto-load Starter-Kit when user picks the new-franchise-setup priority.
  useEffect(() => {
    if (priority !== "new_franchise_setup" || !franchiseId) {
      if (mode === "starter_kit") setMode("choose");
      setStarterKit(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setKitLoading(true);
      try {
        const r = await api.get(`/franchises/${franchiseId}/starter-kit/indent-prefill`);
        if (cancelled) return;
        setStarterKit(r.data);
        setMode("starter_kit");
      } catch (e) {
        if (!cancelled) {
          toast.error(e?.response?.data?.detail || "No Starter-Kit on this franchise. Assign a tier first.");
          setPriority("routine");
        }
      } finally {
        if (!cancelled) setKitLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [priority, franchiseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitFile = async (file, endpoint) => {
    if (!franchiseId) { toast.error("Pick a franchise first"); return; }
    if (!file) { toast.error("Choose a file"); return; }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("franchise_id", franchiseId);
      fd.append("priority", priority === "new_franchise_setup" ? "routine" : priority);
      fd.append("notes", notes);
      const r = await api.post(endpoint, fd, { headers: { "Content-Type": "multipart/form-data" } });
      setResult(r.data);
      toast.success(`Indent ${r.data.indent?.indent_number} created`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Order creation failed");
    } finally { setSubmitting(false); }
  };

  if (result) {
    const ind = result.indent;
    return (
      <div className="space-y-6 max-w-2xl mx-auto" data-testid="new-order-result">
        <div className="flex items-center justify-center w-16 h-16 mx-auto rounded-full bg-emerald-500/15 text-emerald-600">
          <CheckCircle size={32} weight="fill" />
        </div>
        <div className="text-center">
          <h1 className="font-display text-3xl font-semibold">Order Submitted</h1>
          <div className="text-sm text-muted-foreground mt-1">{ind.indent_number}</div>
        </div>
        <div className="border border-border rounded-md p-5 bg-card space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Franchise</span> <span>{ind.franchise_name}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Source</span> <Badge variant="outline">{ind.source?.toUpperCase()}</Badge></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Items</span> <span>{ind.line_items?.length}</span></div>
          <div className="flex justify-between font-medium"><span>Total</span> <span className="tabular-nums">{formatINR(ind.total_amount)}</span></div>
          {ind.unmatched?.length > 0 && (
            <div className="pt-3 border-t border-border mt-3">
              <div className="text-xs text-amber-600 font-medium mb-1">{ind.unmatched.length} unmatched items skipped:</div>
              <ul className="text-xs text-muted-foreground space-y-0.5 max-h-32 overflow-auto">
                {ind.unmatched.map((u, i) => <li key={i}>• {u.sku || u.description} × {u.qty}</li>)}
              </ul>
            </div>
          )}
        </div>
        <div className="flex gap-2 justify-center">
          <Button variant="outline" onClick={() => { setResult(null); setMode("choose"); }} data-testid="new-another-btn">Create Another</Button>
          <Button onClick={() => navigate("/indents")} data-testid="goto-indents-btn">View All Indents</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="new-order-page">
      <div>
        <button onClick={() => navigate("/indents")} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-2" data-testid="back-to-indents">
          <ArrowLeft size={12} /> Back to Indents
        </button>
        <div className="text-xs uppercase tracking-[0.25em] text-muted-foreground">Indents</div>
        <h1 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight mt-2">Create New Order</h1>
        <p className="text-sm text-muted-foreground mt-1">Choose how you want to raise this indent — system entry, photo capture, or Excel upload.</p>
      </div>

      {/* Shared meta */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 rounded-md border border-border bg-card p-4">
        <div>
          <Label>Franchise</Label>
          <Select value={franchiseId} onValueChange={setFranchiseId} disabled={user?.role === "franchise_manager"}>
            <SelectTrigger data-testid="franchise-select"><SelectValue placeholder="Pick a franchise" /></SelectTrigger>
            <SelectContent>
              {franchises.map((f) => <SelectItem key={f.id} value={f.id}>{f.name} ({f.code})</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Priority</Label>
          <Select value={priority} onValueChange={setPriority}>
            <SelectTrigger data-testid="priority-select"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="routine">Normal (Routine)</SelectItem>
              <SelectItem value="urgent">Urgent</SelectItem>
              <SelectItem value="emergency">Emergency</SelectItem>
              <SelectItem value="new_franchise_setup">⭐ New Franchise Setup</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Notes (optional)</Label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything for the warehouse?" data-testid="notes-input" />
        </div>
      </div>

      {/* Method picker */}
      {mode === "choose" && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <MethodCard
            id="system"
            icon={Keyboard}
            title="System Entry"
            subtitle="Pick SKUs from catalog with current prices."
            onClick={() => setMode("system")}
            testid="method-system"
          />
          <MethodCard
            id="photo"
            icon={Camera}
            title="Photo Order"
            subtitle="Capture or upload a hand-written / printed order sheet. AI extracts each line."
            badge="AI"
            onClick={() => setMode("photo")}
            testid="method-photo"
          />
          <MethodCard
            id="excel"
            icon={FileXls}
            title="Excel Order"
            subtitle="Upload .xlsx / .csv with SKU + Qty columns."
            onClick={() => setMode("excel")}
            testid="method-excel"
          />
        </div>
      )}

      {mode === "starter_kit" && (
        kitLoading ? (
          <div className="text-sm text-muted-foreground py-8 text-center">Loading Starter-Kit…</div>
        ) : (
          <StarterKitOrderForm
            franchiseId={franchiseId}
            priority={priority}
            notes={notes}
            kit={starterKit}
            onSubmitted={(d) => setResult({ indent: d })}
            onBack={() => { setPriority("routine"); setMode("choose"); }}
          />
        )
      )}
      {mode === "system" && <SystemEntryForm franchiseId={franchiseId} priority={priority === "new_franchise_setup" ? "routine" : priority} notes={notes} onSubmitted={setResult} onBack={() => setMode("choose")} />}
      {mode === "photo" && <PhotoOrderForm onBack={() => setMode("choose")} onSubmit={(f) => submitFile(f, "/indents/photo")} submitting={submitting} />}
      {mode === "excel" && <ExcelOrderForm onBack={() => setMode("choose")} onSubmit={(f) => submitFile(f, "/indents/excel")} submitting={submitting} />}
    </div>
  );
}

function MethodCard({ icon: Icon, title, subtitle, onClick, badge, testid }) {
  return (
    <button
      onClick={onClick}
      className="text-left border border-border rounded-md p-6 bg-card hover:border-foreground transition-all lift-on-hover"
      data-testid={testid}
    >
      <div className="flex items-center justify-between">
        <div className="flex h-12 w-12 items-center justify-center rounded-md bg-foreground text-background">
          <Icon size={24} weight="duotone" />
        </div>
        {badge && <Badge variant="outline" className="bg-violet-500/10 text-violet-600 border-violet-500/30">{badge}</Badge>}
      </div>
      <div className="mt-4 font-display text-lg font-semibold">{title}</div>
      <div className="mt-1 text-sm text-muted-foreground">{subtitle}</div>
    </button>
  );
}

function SystemEntryForm({ franchiseId, priority, notes, onSubmitted, onBack }) {
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState("");
  const [items, setItems] = useState([]); // {product_id, sku, name, price, requested_qty}
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { api.get("/products?limit=2000").then((r) => setProducts(r.data)); }, []);

  const filtered = products.filter(p => {
    const q = search.trim().toLowerCase();
    if (!q) return false;
    return p.sku?.toLowerCase().includes(q) || p.name?.toLowerCase().includes(q);
  }).slice(0, 8);

  const addItem = (p) => {
    if (items.find((i) => i.product_id === p.id)) return;
    setItems([...items, {
      product_id: p.id, sku: p.sku, name: p.name,
      price: p.franchise_price || 0, requested_qty: 1,
    }]);
    setSearch("");
  };
  const updateQty = (id, qty) => {
    // Allow empty/intermediate string; sanitize leading zeros; cap at save time.
    let next = qty;
    if (typeof qty === "string" && qty.length > 1 && qty.startsWith("0")) next = qty.replace(/^0+/, "") || "0";
    setItems(items.map((i) => i.product_id === id ? { ...i, requested_qty: next } : i));
  };
  const remove = (id) => setItems(items.filter((i) => i.product_id !== id));

  const total = items.reduce((s, i) => s + i.price * (Number(i.requested_qty) || 0), 0);

  const submit = async () => {
    if (!franchiseId) { toast.error("Pick a franchise"); return; }
    if (items.length === 0) { toast.error("Add at least one item"); return; }
    setSubmitting(true);
    try {
      const r = await api.post("/indents", {
        franchise_id: franchiseId,
        priority,
        notes,
        line_items: items.map(i => ({ product_id: i.product_id, requested_qty: Math.max(1, Number(i.requested_qty) || 1) })),
      });
      onSubmitted({ indent: r.data });
      toast.success(`Indent ${r.data.indent_number} created`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed");
    } finally { setSubmitting(false); }
  };

  return (
    <div className="space-y-4">
      <Button variant="ghost" onClick={onBack} size="sm"><ArrowLeft size={12} className="mr-1" /> Switch method</Button>
      <div className="rounded-md border border-border bg-card p-4 space-y-3">
        <Label>Search & Add Products</Label>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type SKU or name…" data-testid="sys-search-input" />
        {filtered.length > 0 && (
          <div className="rounded border border-border max-h-60 overflow-y-auto">
            {filtered.map((p) => (
              <button key={p.id} onClick={() => addItem(p)} className="block w-full text-left px-3 py-2 hover:bg-muted text-sm border-b border-border last:border-b-0" data-testid={`sys-add-${p.sku}`}>
                <div className="font-mono text-xs text-muted-foreground">{p.sku}</div>
                <div className="flex justify-between"><span>{p.name}</span><span className="tabular-nums">{formatINR(p.franchise_price)}</span></div>
              </button>
            ))}
          </div>
        )}

        {items.length > 0 && (
          <div className="rounded border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="px-3 py-2">SKU</th><th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2 text-right">Price</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.product_id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">{i.sku}</td>
                    <td className="px-3 py-2">{i.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatINR(i.price)}</td>
                    <td className="px-3 py-2 text-right">
                      <Input type="number" inputMode="numeric" min={1} value={i.requested_qty ?? ""} onFocus={(e) => e.target.select()} onChange={(e) => updateQty(i.product_id, e.target.value)} className="w-20 ml-auto h-8" data-testid={`sys-qty-${i.sku}`} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatINR(i.price * (Number(i.requested_qty) || 0))}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => remove(i.product_id)} className="rounded p-1 hover:bg-destructive/10 text-destructive" data-testid={`sys-remove-${i.sku}`}><Trash size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-muted/40 border-t border-border font-medium">
                  <td colSpan={4} className="px-3 py-2 text-right">Total</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatINR(total)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <div className="flex justify-end">
          <Button onClick={submit} disabled={items.length === 0 || submitting} data-testid="sys-submit-btn">
            {submitting ? "Submitting…" : <><Plus size={14} className="mr-2" />Raise Indent</>}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PhotoOrderForm({ onBack, onSubmit, submitting }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const inputRef = useRef(null);

  const onChange = (e) => {
    const f = e.target.files?.[0];
    setFile(f || null);
    setPreview(f ? URL.createObjectURL(f) : null);
  };

  return (
    <div className="space-y-4">
      <Button variant="ghost" onClick={onBack} size="sm"><ArrowLeft size={12} className="mr-1" /> Switch method</Button>
      <div className="rounded-md border border-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Camera size={24} weight="duotone" />
          <div>
            <div className="font-display text-base font-medium">Photo Order</div>
            <div className="text-xs text-muted-foreground">JPG / PNG / WEBP — AI extracts SKU + Qty from each line.</div>
          </div>
        </div>
        <input
          ref={inputRef} type="file" accept="image/*" capture="environment"
          onChange={onChange}
          className="block w-full text-sm file:mr-3 file:rounded file:border-0 file:bg-foreground file:px-3 file:py-2 file:text-background"
          data-testid="photo-file-input"
        />
        {preview && (
          <div className="rounded-md border border-border overflow-hidden">
            <img src={preview} alt="preview" className="max-h-80 w-full object-contain bg-muted/30" />
          </div>
        )}
        <Button onClick={() => onSubmit(file)} disabled={!file || submitting} className="w-full" data-testid="photo-submit-btn">
          <UploadSimple size={14} className="mr-2" />
          {submitting ? "AI is reading your order…" : "Upload & Extract Items"}
        </Button>
      </div>
    </div>
  );
}

function ExcelOrderForm({ onBack, onSubmit, submitting }) {
  const [file, setFile] = useState(null);
  return (
    <div className="space-y-4">
      <Button variant="ghost" onClick={onBack} size="sm"><ArrowLeft size={12} className="mr-1" /> Switch method</Button>
      <div className="rounded-md border border-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-2">
          <FileXls size={24} weight="duotone" />
          <div>
            <div className="font-display text-base font-medium">Excel Order</div>
            <div className="text-xs text-muted-foreground">Upload .xlsx / .xls / .csv. Required columns: <code className="text-foreground">SKU</code> + <code className="text-foreground">Qty</code>.</div>
          </div>
        </div>
        <input
          type="file" accept=".xlsx,.xls,.csv"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          className="block w-full text-sm file:mr-3 file:rounded file:border-0 file:bg-foreground file:px-3 file:py-2 file:text-background"
          data-testid="excel-file-input"
        />
        {file && <div className="text-xs text-muted-foreground"><FileXls size={12} className="inline mr-1" /> {file.name}</div>}
        <Button onClick={() => onSubmit(file)} disabled={!file || submitting} className="w-full" data-testid="excel-submit-btn">
          <UploadSimple size={14} className="mr-2" />
          {submitting ? "Importing…" : "Upload & Create Indent"}
        </Button>
      </div>
    </div>
  );
}

// ----- New Franchise Setup: pre-filled, fully editable order from Starter-Kit -----
function StarterKitOrderForm({ franchiseId, priority, notes, kit, onSubmitted, onBack }) {
  const [items, setItems] = useState([]); // {product_id, sku, name, requested_qty, unit_price, discount_percent, margin_percent (nullable), mrp, selling_price}
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (kit?.line_items) {
      setItems(kit.line_items.map((it) => ({
        product_id: it.product_id,
        sku: it.sku,
        name: it.product_name,
        requested_qty: it.requested_qty,
        unit_price: it.unit_price,
        discount_percent: it.discount_percent ?? 0,
        margin_percent: it.margin_percent ?? null,
        mrp: it.mrp ?? 0,
        selling_price: it.selling_price ?? it.unit_price,
      })));
    }
  }, [kit]);

  useEffect(() => { api.get("/products?limit=2000").then((r) => setProducts(r.data)); }, []);

  const tierMargin = Number(kit?.default_margin_percent || 22);

  const stripZero = (v) => (typeof v === "string" && v.length > 1 && v.startsWith("0") && !v.startsWith("0.")) ? v.replace(/^0+/, "") || "0" : v;

  const recompute = (row) => {
    const cost = Number(row.cost_price ?? products.find((p) => p.id === row.product_id)?.landing_price ?? 0);
    const itemMargin = row.margin_percent;
    const margin = itemMargin === null || itemMargin === "" ? tierMargin : Number(itemMargin);
    const base = Number(row.margin_percent !== null && row.margin_percent !== "" && row.margin_percent !== undefined
      ? Math.round(cost * (1 + margin / 100) * 100) / 100
      : row.unit_price);
    const disc = Number(row.discount_percent || 0);
    const selling = Math.round(base * (1 - disc / 100) * 100) / 100;
    return { ...row, unit_price: base, selling_price: selling };
  };

  const updateField = (idx, field, val) => {
    setItems((arr) => {
      const next = [...arr];
      next[idx] = recompute({ ...next[idx], [field]: stripZero(val) });
      return next;
    });
  };
  const removeRow = (idx) => setItems((arr) => arr.filter((_, i) => i !== idx));

  const filtered = products.filter((p) => {
    const q = search.trim().toLowerCase();
    if (!q) return false;
    if (items.some((i) => i.product_id === p.id)) return false; // no duplicates
    return p.sku?.toLowerCase().includes(q) || p.name?.toLowerCase().includes(q);
  }).slice(0, 6);

  const addProduct = (p) => {
    const base = Math.round((Number(p.landing_price) || 0) * (1 + tierMargin / 100) * 100) / 100;
    setItems([...items, {
      product_id: p.id, sku: p.sku, name: p.name,
      requested_qty: 1,
      unit_price: base,
      discount_percent: 0,
      margin_percent: null,
      mrp: p.mrp || 0,
      selling_price: base,
    }]);
    setSearch("");
  };

  const grandTotal = items.reduce((s, i) => s + (Number(i.selling_price) || 0) * (Number(i.requested_qty) || 0), 0);

  const submit = async () => {
    if (!franchiseId) { toast.error("Pick a franchise"); return; }
    if (items.length === 0) { toast.error("Add at least one item"); return; }
    setSubmitting(true);
    try {
      const r = await api.post("/indents", {
        franchise_id: franchiseId,
        priority,  // "new_franchise_setup"
        notes,
        starter_kit_snapshot_version: kit?.snapshot_version,
        source: "starter_kit",
        line_items: items.map((i) => ({
          product_id: i.product_id,
          requested_qty: Math.max(1, Number(i.requested_qty) || 1),
          unit_price: Number(i.unit_price) || 0,
          discount_percent: Number(i.discount_percent) || 0,
          margin_percent: (i.margin_percent === null || i.margin_percent === "") ? null : Number(i.margin_percent),
        })),
      });
      onSubmitted(r.data);
      toast.success(`Indent ${r.data.indent_number} created`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed");
    } finally { setSubmitting(false); }
  };

  const fmt = formatINR;

  return (
    <div className="space-y-4" data-testid="starter-kit-order-form">
      <Button variant="ghost" onClick={onBack} size="sm"><ArrowLeft size={12} className="mr-1" /> Switch method</Button>

      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.03] p-4">
        <div className="flex items-center gap-2 mb-1">
          <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30">⭐ New Franchise Setup</Badge>
          <span className="text-xs text-muted-foreground">
            Loaded {kit?.line_items?.length || 0} items from <b>{kit?.tier_name || "Starter-Kit"}</b> snapshot
            {kit?.snapshot_version ? ` v${kit.snapshot_version}` : ""}. Edit anything before submitting — changes won't touch the template.
          </span>
        </div>
      </div>

      <div className="rounded-md border border-border bg-card p-4 space-y-3">
        <Label>Add more products</Label>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search SKU or name…" data-testid="kit-order-search" />
        {filtered.length > 0 && (
          <div className="rounded border border-border max-h-60 overflow-y-auto">
            {filtered.map((p) => (
              <button key={p.id} onClick={() => addProduct(p)} className="block w-full text-left px-3 py-2 hover:bg-muted text-sm border-b border-border last:border-b-0" data-testid={`kit-order-add-${p.sku}`}>
                <div className="font-mono text-xs text-muted-foreground">{p.sku}</div>
                <div className="flex justify-between"><span>{p.name}</span><span className="tabular-nums">{fmt(p.franchise_price)}</span></div>
              </button>
            ))}
          </div>
        )}

        {items.length > 0 && (
          <div className="rounded border border-border overflow-hidden overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/40">
                <tr className="text-left text-[10px] uppercase text-muted-foreground">
                  <th className="px-2 py-2">SKU</th>
                  <th className="px-2 py-2">Item</th>
                  <th className="px-2 py-2 text-right">MRP</th>
                  <th className="px-2 py-2 text-center">Margin %</th>
                  <th className="px-2 py-2 text-center">Disc %</th>
                  <th className="px-2 py-2 text-center">Qty</th>
                  <th className="px-2 py-2 text-right">Rate</th>
                  <th className="px-2 py-2 text-right">Selling</th>
                  <th className="px-2 py-2 text-right">Line ₹</th>
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((i, idx) => {
                  const line = (Number(i.selling_price) || 0) * (Number(i.requested_qty) || 0);
                  return (
                    <tr key={i.product_id || idx} className="border-t border-border" data-testid={`kit-line-${idx}`}>
                      <td className="px-2 py-1.5 font-mono text-[11px]">{i.sku}</td>
                      <td className="px-2 py-1.5">{i.name}</td>
                      <td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums">{fmt(i.mrp)}</td>
                      <td className="px-2 py-1.5">
                        <Input type="number" step="0.5" placeholder={String(tierMargin)} value={i.margin_percent ?? ""}
                          onChange={(e) => updateField(idx, "margin_percent", e.target.value === "" ? null : e.target.value)}
                          onFocus={(e) => e.target.select()} className="w-20 mx-auto h-8 text-center text-xs" data-testid={`kit-line-${idx}-margin`} />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input type="number" step="0.5" min={0} max={100} value={i.discount_percent ?? 0}
                          onChange={(e) => updateField(idx, "discount_percent", e.target.value)}
                          onFocus={(e) => e.target.select()} className="w-20 mx-auto h-8 text-center text-xs" data-testid={`kit-line-${idx}-discount`} />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input type="number" inputMode="numeric" min={1} value={i.requested_qty ?? ""}
                          onChange={(e) => updateField(idx, "requested_qty", e.target.value)}
                          onFocus={(e) => e.target.select()} className="w-16 mx-auto h-8 text-center text-xs" data-testid={`kit-line-${idx}-qty`} />
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmt(i.unit_price)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-medium" data-testid={`kit-line-${idx}-selling`}>{fmt(i.selling_price)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-medium" data-testid={`kit-line-${idx}-total`}>{fmt(line)}</td>
                      <td className="px-2 py-1.5 text-right">
                        <button onClick={() => removeRow(idx)} className="rounded p-1 hover:bg-destructive/10 text-destructive" data-testid={`kit-line-${idx}-remove`}><Trash size={13} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-muted/40 border-t border-border font-medium">
                  <td colSpan={8} className="px-2 py-2 text-right">Grand Total</td>
                  <td className="px-2 py-2 text-right tabular-nums" data-testid="kit-order-grand-total">{fmt(grandTotal)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <div className="flex justify-end">
          <Button onClick={submit} disabled={items.length === 0 || submitting} data-testid="kit-order-submit">
            {submitting ? "Submitting…" : <><Plus size={14} className="mr-2" />Raise Indent</>}
          </Button>
        </div>
      </div>
    </div>
  );
}

