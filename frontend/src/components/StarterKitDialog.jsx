import React, { useEffect, useMemo, useRef, useState } from "react";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus, Trash, MagnifyingGlass, X, CheckCircle, Info } from "@phosphor-icons/react";

/**
 * Per-tier or per-franchise Starter-Kit editor with per-item discount + margin.
 *
 * Pricing engine (kept in sync with backend _resolve_kit_item_pricing):
 *   margin    = item.margin_percent  ?? tier.default_margin_percent
 *   base      = round(cost * (1 + margin/100), 2)      // franchise price
 *   selling   = round(base * (1 - discount/100), 2)
 *   line_inv  = cost * qty
 *   line_sell = selling * qty
 *   profit    = (selling - cost) * qty
 *
 * Props
 *   mode      — 'tier' (template) or 'franchise' (per-franchise snapshot)
 *   tier      — { id, name, color, margin_percent } (for mode='tier')
 *   franchise — { id, name } (for mode='franchise')
 *   onClose() — close handler
 *   onSaved() — optional callback after save
 */
export default function StarterKitDialog({ mode = "tier", tier, franchise, onClose, onSaved }) {
  const isFranchise = mode === "franchise";
  const subject = isFranchise ? franchise : tier;
  const titleSubject = isFranchise ? franchise?.name : tier?.name;
  const titleColor = isFranchise ? "#10b981" : (tier?.color || "#f59e0b");

  const [defaultMargin, setDefaultMargin] = useState(tier?.margin_percent ?? 22);
  const [rows, setRows] = useState([]); // each: { product_id, sku, name, recommended_qty, discount_percent, margin_percent (nullable) }
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [products, setProducts] = useState([]); // catalog for picker — cached
  const [productById, setProductById] = useState({});
  const [openPickerIdx, setOpenPickerIdx] = useState(null);
  const [meta, setMeta] = useState({}); // for franchise snapshot: tier_name, version, captured_at

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const kitPath = isFranchise
          ? `/franchises/${franchise.id}/starter-kit`
          : `/franchise-tiers/${tier.id}/starter-kit`;
        const [kitRes, prodRes] = await Promise.all([
          api.get(kitPath),
          api.get("/products?limit=2000"),
        ]);
        if (cancelled) return;
        const data = kitRes.data || {};
        setDefaultMargin(data.default_margin_percent ?? tier?.margin_percent ?? 22);
        setRows((data.items || []).map((it) => ({
          product_id: it.product_id,
          sku: it.sku,
          name: it.name,
          recommended_qty: it.recommended_qty,
          discount_percent: it.discount_percent ?? 0,
          margin_percent: it.margin_percent ?? null, // null = use tier default
        })));
        setMeta({
          tier_name: data.tier_name || "",
          version: data.version || 1,
          captured_at: data.captured_at || "",
          has_snapshot: data.has_snapshot !== false,
        });
        const list = (prodRes.data || []).filter((p) => p.active !== false);
        setProducts(list);
        const map = {};
        list.forEach((p) => { map[p.id] = p; });
        setProductById(map);
      } catch (e) {
        toast.error(e?.response?.data?.detail || "Failed to load template");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [subject?.id, isFranchise]); // eslint-disable-line react-hooks/exhaustive-deps

  const usedIds = useMemo(() => new Set(rows.map((r) => r.product_id).filter(Boolean)), [rows]);

  const addRow = () => {
    setRows((r) => [...r, { product_id: "", sku: "", name: "", recommended_qty: 1, discount_percent: 0, margin_percent: null }]);
    setTimeout(() => setOpenPickerIdx(rows.length), 50);
  };
  const removeRow = (idx) => setRows((r) => r.filter((_, i) => i !== idx));

  const setRowProduct = (idx, prod) => {
    if (usedIds.has(prod.id) && rows[idx]?.product_id !== prod.id) {
      toast.error(`${prod.name} is already in the template`);
      return;
    }
    setRows((r) => {
      const next = [...r];
      next[idx] = { ...next[idx], product_id: prod.id, sku: prod.sku, name: prod.name };
      if (!next[idx].recommended_qty) next[idx].recommended_qty = 1;
      return next;
    });
    setOpenPickerIdx(null);
  };

  const stripLeadingZero = (val) => {
    if (typeof val !== "string") return val;
    if (val.length > 1 && val.startsWith("0") && !val.startsWith("0.")) return val.replace(/^0+/, "") || "0";
    return val;
  };
  const setRowField = (idx, field, val) => {
    setRows((r) => {
      const next = [...r];
      next[idx] = { ...next[idx], [field]: stripLeadingZero(val) };
      return next;
    });
  };
  const setRowMargin = (idx, val) => {
    setRows((r) => {
      const next = [...r];
      next[idx] = { ...next[idx], margin_percent: val === "" || val === null ? null : stripLeadingZero(val) };
      return next;
    });
  };

  // ----- Live pricing per row -----
  const priced = useMemo(() => {
    const tm = Number(defaultMargin) || 0;
    return rows.map((row) => {
      const p = productById[row.product_id] || {};
      const cost = Number(p.landing_price || 0);
      const mrp = Number(p.mrp || 0);
      const itemMargin = row.margin_percent;
      const margin = itemMargin === null || itemMargin === "" ? tm : Number(itemMargin);
      const base = Math.round(cost * (1 + margin / 100) * 100) / 100;
      const disc = Number(row.discount_percent || 0);
      const selling = Math.round(base * (1 - disc / 100) * 100) / 100;
      const qty = Number(row.recommended_qty || 0);
      return {
        ...row,
        cost, mrp, marginEffective: margin, base, selling, qty,
        invValue: Math.round(cost * qty * 100) / 100,
        sellValue: Math.round(selling * qty * 100) / 100,
        profit: Math.round((selling - cost) * qty * 100) / 100,
      };
    });
  }, [rows, defaultMargin, productById]);

  const totals = useMemo(() => priced.reduce((acc, r) => ({
    qty: acc.qty + r.qty,
    inv: acc.inv + r.invValue,
    sell: acc.sell + r.sellValue,
    profit: acc.profit + r.profit,
  }), { qty: 0, inv: 0, sell: 0, profit: 0 }), [priced]);

  const save = async () => {
    const cleanRows = rows.filter((r) => r.product_id);
    if (cleanRows.length === 0 && rows.length > 0) {
      toast.error("Pick a product for each row, or remove empty rows");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        default_margin_percent: Number(defaultMargin) || 0,
        items: cleanRows.map((r) => ({
          product_id: r.product_id,
          recommended_qty: Number(r.recommended_qty) || 0,
          discount_percent: Number(r.discount_percent) || 0,
          margin_percent: r.margin_percent === null || r.margin_percent === ""
            ? null
            : Number(r.margin_percent),
        })),
      };
      const path = isFranchise
        ? `/franchises/${franchise.id}/starter-kit`
        : `/franchise-tiers/${tier.id}/starter-kit`;
      await api.put(path, payload);
      toast.success(isFranchise ? "Franchise Starter-Kit saved" : "Template saved");
      if (onSaved) onSaved();
      onClose();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const fmtINR = (n) => "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-6xl" data-testid="starter-kit-dialog">
        <DialogHeader>
          <DialogTitle className="font-display flex items-center gap-2">
            Starter-Kit Template — <span style={{ color: titleColor }}>{titleSubject}</span>
            {isFranchise && meta.tier_name && (
              <span className="text-xs font-normal text-muted-foreground">
                (snapshot of <b>{meta.tier_name}</b> · v{meta.version})
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="space-y-4">
            {/* Header controls */}
            <div className="grid grid-cols-3 gap-4 items-end">
              <div>
                <Label>Default Margin %</Label>
                <Input
                  type="number" step="0.5" value={defaultMargin}
                  onChange={(e) => setDefaultMargin(e.target.value)}
                  onFocus={(e) => e.target.select()}
                  data-testid="kit-margin"
                />
                <div className="text-[10px] text-muted-foreground mt-1 flex items-start gap-1">
                  <Info size={10} className="mt-0.5 shrink-0" />
                  <span>Used only when a row's own margin is empty.</span>
                </div>
              </div>
              <div className="col-span-2 grid grid-cols-4 gap-2">
                <Pill label="Items" value={priced.length} />
                <Pill label="Total Qty" value={totals.qty.toLocaleString("en-IN")} />
                <Pill label="Inventory Value" value={fmtINR(totals.inv)} />
                <Pill label="Expected Profit" value={fmtINR(totals.profit)} positive={totals.profit > 0} />
              </div>
            </div>

            {/* Item table */}
            <div className="rounded-md border border-border bg-card overflow-hidden">
              <div className="px-3 py-2 border-b border-border grid grid-cols-12 gap-2 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/30">
                <div className="col-span-4">Product</div>
                <div className="col-span-1 text-right">Cost</div>
                <div className="col-span-1 text-right">MRP</div>
                <div className="col-span-1 text-center">Margin %</div>
                <div className="col-span-1 text-center">Disc %</div>
                <div className="col-span-1 text-center">Qty</div>
                <div className="col-span-1 text-right">Selling</div>
                <div className="col-span-1 text-right">Line ₹</div>
                <div className="col-span-1"></div>
              </div>

              <div className="max-h-[50vh] overflow-y-auto divide-y divide-border">
                {priced.length === 0 && (
                  <div className="px-3 py-8 text-center text-xs text-muted-foreground" data-testid="kit-empty">
                    No items yet. Click <b>Add Item</b> below.
                  </div>
                )}
                {priced.map((row, idx) => (
                  <div key={idx} className="px-3 py-2 grid grid-cols-12 gap-2 items-center relative" data-testid={`kit-row-${idx}`}>
                    {/* Product picker */}
                    <div className="col-span-4 relative">
                      <button
                        type="button"
                        onClick={() => setOpenPickerIdx(openPickerIdx === idx ? null : idx)}
                        className="w-full text-left rounded border border-border bg-background px-2 py-1.5 text-xs hover:bg-muted/50 flex items-center justify-between gap-2"
                        data-testid={`kit-row-${idx}-picker`}
                      >
                        {row.product_id ? (
                          <span className="truncate">
                            <span className="font-mono text-[10px] text-muted-foreground mr-1">{row.sku}</span>
                            {row.name}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">— pick a product —</span>
                        )}
                        <MagnifyingGlass size={12} className="text-muted-foreground shrink-0" />
                      </button>
                      {openPickerIdx === idx && (
                        <ProductPicker
                          products={products}
                          excludeIds={Array.from(usedIds).filter((id) => id !== row.product_id)}
                          onPick={(p) => setRowProduct(idx, p)}
                          onClose={() => setOpenPickerIdx(null)}
                          testIdPrefix={`kit-row-${idx}`}
                        />
                      )}
                    </div>
                    {/* Cost */}
                    <div className="col-span-1 text-right tabular-nums text-xs text-muted-foreground">{fmtINR(row.cost)}</div>
                    {/* MRP */}
                    <div className="col-span-1 text-right tabular-nums text-xs text-muted-foreground">{fmtINR(row.mrp)}</div>
                    {/* Margin (override) */}
                    <div className="col-span-1">
                      <Input
                        type="number" step="0.5"
                        placeholder={String(defaultMargin)}
                        value={row.margin_percent ?? ""}
                        onChange={(e) => setRowMargin(idx, e.target.value)}
                        onFocus={(e) => e.target.select()}
                        className="h-8 text-xs text-center"
                        data-testid={`kit-row-${idx}-margin`}
                      />
                    </div>
                    {/* Discount */}
                    <div className="col-span-1">
                      <Input
                        type="number" step="0.5" min={0} max={100}
                        value={row.discount_percent ?? 0}
                        onChange={(e) => setRowField(idx, "discount_percent", e.target.value)}
                        onFocus={(e) => e.target.select()}
                        className="h-8 text-xs text-center"
                        data-testid={`kit-row-${idx}-discount`}
                      />
                    </div>
                    {/* Qty */}
                    <div className="col-span-1">
                      <Input
                        type="number" min={0} inputMode="numeric"
                        value={row.recommended_qty ?? ""}
                        onChange={(e) => setRowField(idx, "recommended_qty", e.target.value)}
                        onFocus={(e) => e.target.select()}
                        className="h-8 text-xs text-center"
                        data-testid={`kit-row-${idx}-qty`}
                      />
                    </div>
                    {/* Selling */}
                    <div className="col-span-1 text-right tabular-nums text-xs font-medium" data-testid={`kit-row-${idx}-selling`}>
                      {fmtINR(row.selling)}
                    </div>
                    {/* Line total */}
                    <div className="col-span-1 text-right tabular-nums text-xs font-medium" data-testid={`kit-row-${idx}-line-total`}>
                      {fmtINR(row.sellValue)}
                    </div>
                    {/* Remove */}
                    <div className="col-span-1 flex justify-end">
                      <button
                        type="button"
                        onClick={() => removeRow(idx)}
                        className="rounded p-1.5 hover:bg-destructive/10 text-destructive"
                        title="Remove"
                        data-testid={`kit-row-${idx}-remove`}
                      >
                        <Trash size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="px-3 py-2 border-t border-border bg-muted/20">
                <Button
                  type="button" variant="outline" size="sm"
                  onClick={addRow}
                  data-testid="kit-add-item"
                  className="w-full justify-center"
                >
                  <Plus size={14} className="mr-1" /> Add Item
                </Button>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={onClose} disabled={saving} data-testid="kit-cancel">Cancel</Button>
              <Button onClick={save} disabled={saving} data-testid="kit-save">
                {saving ? "Saving…" : (<><CheckCircle size={14} className="mr-1" /> Save Template</>)}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}


function Pill({ label, value, positive }) {
  return (
    <div className="rounded-md border border-border bg-card px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-sm tabular-nums font-semibold ${positive ? "text-emerald-600 dark:text-emerald-400" : ""}`}>{value}</div>
    </div>
  );
}


function ProductPicker({ products, excludeIds, onPick, onClose, testIdPrefix }) {
  const [q, setQ] = useState("");
  const inputRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const handler = (e) => {
      if (!containerRef.current?.contains(e.target)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const excl = new Set(excludeIds || []);
    return (products || [])
      .filter((p) => !excl.has(p.id))
      .filter((p) => {
        if (!term) return true;
        return (p.sku || "").toLowerCase().includes(term)
          || (p.name || "").toLowerCase().includes(term)
          || (p.brand || "").toLowerCase().includes(term)
          || (p.category || "").toLowerCase().includes(term);
      })
      .slice(0, 50);
  }, [q, products, excludeIds]);

  return (
    <div
      ref={containerRef}
      className="absolute z-50 left-0 right-0 top-[105%] bg-popover border border-border rounded-md shadow-lg max-h-72 overflow-hidden flex flex-col"
      data-testid={`${testIdPrefix}-product-list`}
    >
      <div className="sticky top-0 bg-popover border-b border-border p-2 flex items-center gap-2">
        <MagnifyingGlass size={14} className="text-muted-foreground" />
        <Input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by SKU, name, brand, category…"
          className="h-7 text-xs"
          data-testid={`${testIdPrefix}-product-search`}
        />
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground"><X size={14} /></button>
      </div>
      <div className="overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">No products match.</div>
        )}
        {filtered.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onPick(p)}
            className="block w-full text-left px-3 py-2 hover:bg-muted/60 border-t border-border first:border-t-0 text-sm"
            data-testid={`${testIdPrefix}-product-option-${p.sku}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] text-muted-foreground">{p.sku}</span>
              {p.category && <span className="text-[10px] text-muted-foreground">{p.category}</span>}
            </div>
            <div className="text-xs">{p.name}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
