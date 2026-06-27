import React, { useEffect, useState } from "react";
import api, { formatINR } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus, Trash, Crown, PencilSimple, ArrowLeft, Tag } from "@phosphor-icons/react";
import { useAuth } from "@/lib/auth";
import { useNavigate } from "react-router-dom";
import StarterKitDialog from "@/components/StarterKitDialog";

const emptyTier = {
  name: "", margin_percent: 22, color: "#10b981", category_overrides: [], active: true,
};

export default function FranchiseTiers() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [tiers, setTiers] = useState([]);
  const [editing, setEditing] = useState(null);
  const [categories, setCategories] = useState([]);
  const [preview, setPreview] = useState(null); // {tier, rows}
  const [starterKitTier, setStarterKitTier] = useState(null);
  const [kitTotals, setKitTotals] = useState({}); // tier_id → {total_items, total_qty, inventory_value, selling_value, expected_profit}
  const canEdit = ["super_admin", "hub_accountant"].includes(user?.role);

  const load = async () => {
    const r = await api.get("/franchise-tiers");
    setTiers(r.data);
    // Fan-out to fetch kit aggregates per tier. Cheap (4 calls) and runs in parallel.
    const entries = await Promise.all(
      (r.data || []).map(async (t) => {
        try {
          const p = await api.get(`/franchise-tiers/${t.id}/starter-kit/preview`);
          return [t.id, p.data];
        } catch (_) {
          return [t.id, null];
        }
      }),
    );
    setKitTotals(Object.fromEntries(entries));
  };

  useEffect(() => {
    load();
    api.get("/products?limit=2000").then((r) => {
      setCategories([...new Set(r.data.map((p) => p.category).filter(Boolean))]);
    });
  }, []);

  const save = async () => {
    if (!editing?.name?.trim()) { toast.error("Name required"); return; }
    try {
      const payload = {
        name: editing.name.trim(),
        margin_percent: Number(editing.margin_percent),
        color: editing.color || "",
        active: editing.active !== false,
        category_overrides: (editing.category_overrides || [])
          .filter((c) => c.category && c.margin_percent !== "")
          .map((c) => ({ category: c.category, margin_percent: Number(c.margin_percent) })),
      };
      if (editing.id) await api.put(`/franchise-tiers/${editing.id}`, payload);
      else await api.post("/franchise-tiers", payload);
      toast.success("Tier saved");
      setEditing(null);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Save failed");
    }
  };

  const remove = async (t) => {
    if (t.is_system) { toast.error("System tier cannot be deleted"); return; }
    if (!window.confirm(`Delete tier "${t.name}"?`)) return;
    try {
      await api.delete(`/franchise-tiers/${t.id}`);
      toast.success("Deleted");
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Delete failed");
    }
  };

  const openPreview = async (t) => {
    try {
      const r = await api.get(`/franchise-tiers/${t.id}/preview`);
      setPreview(r.data);
    } catch (e) { toast.error("Preview failed"); }
  };

  const addOverride = () => {
    setEditing({
      ...editing,
      category_overrides: [...(editing.category_overrides || []), { category: "", margin_percent: editing.margin_percent }],
    });
  };
  const updateOverride = (i, field, val) => {
    const list = [...(editing.category_overrides || [])];
    list[i] = { ...list[i], [field]: val };
    setEditing({ ...editing, category_overrides: list });
  };
  const removeOverride = (i) => {
    const list = [...(editing.category_overrides || [])];
    list.splice(i, 1);
    setEditing({ ...editing, category_overrides: list });
  };

  return (
    <div className="space-y-6" data-testid="tiers-page">
      <div className="flex items-center justify-between">
        <div>
          <button onClick={() => navigate("/pricing")} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-2" data-testid="back-to-pricing">
            <ArrowLeft size={12} /> Back to Pricing
          </button>
          <div className="text-xs uppercase tracking-[0.25em] text-muted-foreground">Pricing</div>
          <h1 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight mt-2">Franchise Tier Pricing</h1>
          <p className="text-sm text-muted-foreground mt-1">Assign every franchise to a tier — margin can be global or per-category.</p>
        </div>
        {canEdit && (
          <Button onClick={() => setEditing({ ...emptyTier })} data-testid="new-tier-btn">
            <Plus size={14} className="mr-2" /> New Tier
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {tiers.map((t) => (
          <div key={t.id} className="border border-border rounded-md p-5 bg-card lift-on-hover" data-testid={`tier-card-${t.name}`}>
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded text-background" style={{ background: t.color || "#111827" }}>
                  <Crown size={18} weight="duotone" />
                </div>
                <div>
                  <div className="font-display text-lg font-semibold">{t.name}</div>
                  {t.is_system && <Badge variant="outline" className="text-[10px] mt-0.5">SYSTEM</Badge>}
                </div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-display tabular-nums font-semibold">{t.margin_percent}<span className="text-sm text-muted-foreground">%</span></div>
                <div className="text-[10px] text-muted-foreground">default margin</div>
              </div>
            </div>
            {t.category_overrides?.length > 0 && (
              <div className="mt-4 pt-3 border-t border-border space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Overrides</div>
                {t.category_overrides.map((c, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{c.category}</span>
                    <span className="font-medium tabular-nums">{c.margin_percent}%</span>
                  </div>
                ))}
              </div>
            )}
            {/* Starter-Kit aggregate roll-up */}
            {kitTotals[t.id] && kitTotals[t.id].total_items > 0 && (
              <div className="mt-4 pt-3 border-t border-border" data-testid={`kit-totals-${t.name}`}>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Starter-Kit Roll-up</div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  <Stat label="Items" value={kitTotals[t.id].total_items} />
                  <Stat label="Qty" value={Number(kitTotals[t.id].total_qty || 0).toLocaleString("en-IN")} />
                  <Stat label="Inv Value" value={formatINR(kitTotals[t.id].inventory_value)} />
                  <Stat label="Sell Value" value={formatINR(kitTotals[t.id].selling_value)} />
                  <Stat label="Profit" value={formatINR(kitTotals[t.id].expected_profit)} positive />
                </div>
              </div>
            )}
            <div className="mt-4 pt-4 border-t border-border flex items-center gap-2">
              <button onClick={() => setStarterKitTier(t)} className="text-xs text-muted-foreground hover:text-foreground" data-testid={`preview-items-${t.name}`}>
                <Tag size={12} className="inline mr-1" /> Preview items
              </button>
              <button onClick={() => openPreview(t)} className="text-xs text-muted-foreground hover:text-foreground" data-testid={`preview-tier-${t.name}`}>
                Prices
              </button>
              <div className="ml-auto flex gap-1">
                {canEdit && (
                  <button onClick={() => setEditing({ ...t })} className="rounded p-1.5 hover:bg-muted" data-testid={`edit-tier-${t.name}`}>
                    <PencilSimple size={14} />
                  </button>
                )}
                {canEdit && !t.is_system && (
                  <button onClick={() => remove(t)} className="rounded p-1.5 hover:bg-destructive/10 text-destructive" data-testid={`delete-tier-${t.name}`}>
                    <Trash size={14} />
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Editor dialog */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle className="font-display">{editing?.id ? "Edit Tier" : "Create Tier"}</DialogTitle></DialogHeader>
          {editing && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Name</Label>
                  <Input
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value.toUpperCase() })}
                    disabled={editing.is_system}
                    placeholder="e.g. PREMIUM"
                    data-testid="tier-name-input"
                  />
                </div>
                <div>
                  <Label>Default Margin %</Label>
                  <Input
                    type="number" step="0.5"
                    value={editing.margin_percent}
                    onChange={(e) => setEditing({ ...editing, margin_percent: e.target.value })}
                    data-testid="tier-margin-input"
                  />
                </div>
                <div>
                  <Label>Badge Color</Label>
                  <Input
                    type="color"
                    value={editing.color || "#10b981"}
                    onChange={(e) => setEditing({ ...editing, color: e.target.value })}
                    className="h-9 w-full"
                    data-testid="tier-color-input"
                  />
                </div>
                <div className="flex items-end">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={editing.active !== false}
                      onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
                      data-testid="tier-active-toggle"
                    />
                    Active
                  </label>
                </div>
              </div>

              <div className="rounded-md border border-border p-3">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="text-sm font-medium">Category Margin Overrides</div>
                    <div className="text-[11px] text-muted-foreground">Optional — overrides the default margin for specific categories.</div>
                  </div>
                  <Button size="sm" variant="outline" onClick={addOverride} data-testid="add-override-btn"><Plus size={12} className="mr-1" /> Add</Button>
                </div>
                <div className="space-y-2">
                  {(editing.category_overrides || []).map((c, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2 items-center">
                      <select
                        value={c.category}
                        onChange={(e) => updateOverride(i, "category", e.target.value)}
                        className="col-span-7 rounded border border-border bg-background px-2 py-1.5 text-sm"
                        data-testid={`override-cat-${i}`}
                      >
                        <option value="">— pick category —</option>
                        {categories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
                      </select>
                      <Input
                        type="number" step="0.5"
                        value={c.margin_percent}
                        onChange={(e) => updateOverride(i, "margin_percent", e.target.value)}
                        className="col-span-3"
                        data-testid={`override-margin-${i}`}
                      />
                      <span className="col-span-1 text-xs text-muted-foreground">%</span>
                      <button onClick={() => removeOverride(i)} className="col-span-1 rounded p-1 hover:bg-destructive/10 text-destructive" data-testid={`remove-override-${i}`}>
                        <Trash size={14} />
                      </button>
                    </div>
                  ))}
                  {(editing.category_overrides || []).length === 0 && (
                    <div className="text-xs text-muted-foreground py-2">No overrides — default margin applies to all categories.</div>
                  )}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={save} data-testid="save-tier-btn">Save Tier</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview dialog */}
      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="font-display">
              Price Preview — <span style={{ color: preview?.tier?.color }}>{preview?.tier?.name}</span>
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 sticky top-0">
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2 text-right">Landing</th>
                  <th className="px-3 py-2 text-right">Margin</th>
                  <th className="px-3 py-2 text-right">Tier Price</th>
                  <th className="px-3 py-2 text-right">MRP</th>
                </tr>
              </thead>
              <tbody>
                {preview?.rows?.map((r) => (
                  <tr key={r.product_id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">{r.sku}</td>
                    <td className="px-3 py-2">{r.name}</td>
                    <td className="px-3 py-2 text-muted-foreground text-xs">{r.category}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatINR(r.landing_price)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.margin_percent}%</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{formatINR(r.tier_price)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{formatINR(r.mrp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>
      {/* Starter-Kit Template dialog */}
      {starterKitTier && (
        <StarterKitDialog
          tier={starterKitTier}
          onClose={() => setStarterKitTier(null)}
          onSaved={() => load()}
        />
      )}
    </div>
  );
}

function Stat({ label, value, positive }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums font-medium ${positive ? "text-emerald-600 dark:text-emerald-400" : ""}`}>{value}</span>
    </div>
  );
}
