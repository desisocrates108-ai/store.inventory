import React, { useEffect, useState } from "react";
import api, { formatINR } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus, Storefront, MapPin, Phone, Crown, Package, PencilSimple } from "@phosphor-icons/react";
import { useAuth } from "@/lib/auth";
import DateFilter from "@/components/DateFilter";
import StarterKitDialog from "@/components/StarterKitDialog";

const empty = {
  code: "", name: "", city: "", state: "", address: "", gstin: "",
  contact_phone: "", contact_email: "", credit_limit: 0, active: true,
  tier_id: null,
};

export default function Franchises() {
  const { user } = useAuth();
  const [list, setList] = useState([]);
  const [tiers, setTiers] = useState([]);
  const [editing, setEditing] = useState(null);
  const [dateRange, setDateRange] = useState({ preset: "all", from: "", to: "" });
  const [tierSwap, setTierSwap] = useState(null); // { franchise, newTierId }
  const [kitFranchise, setKitFranchise] = useState(null); // Franchise to edit per-franchise snapshot
  const canEdit = user?.role === "super_admin";
  const canAssignTier = ["super_admin", "hub_accountant"].includes(user?.role);

  const load = () => api.get("/franchises").then((r) => setList(r.data));
  useEffect(() => {
    load();
    api.get("/franchise-tiers").then((r) => setTiers(r.data));
  }, []);

  const filteredList = React.useMemo(() => {
    if (!dateRange.from && !dateRange.to) return list;
    return list.filter((f) => {
      const d = (f.created_at || "").slice(0, 10);
      if (dateRange.from && d < dateRange.from) return false;
      if (dateRange.to && d > dateRange.to) return false;
      return true;
    });
  }, [list, dateRange]);

  const tierById = (id) => tiers.find((t) => t.id === id);

  const handleTierSelect = (franchise, newTierId) => {
    if (!newTierId || newTierId === franchise.tier_id) return;
    if (!franchise.starter_kit) {
      // No existing snapshot — just assign (backend auto-captures).
      doAssignTier(franchise.id, newTierId, false);
      return;
    }
    // Has a snapshot → ask before overwriting.
    setTierSwap({ franchise, newTierId });
  };

  const doAssignTier = async (franchiseId, tierId, replaceStarterKit) => {
    try {
      const r = await api.put(`/franchises/${franchiseId}/tier`, {
        tier_id: tierId || null,
        replace_starter_kit: !!replaceStarterKit,
      });
      const msg = r.data?.snapshot === "replaced"
        ? "Tier changed — Starter-Kit replaced with new tier's template"
        : r.data?.snapshot === "captured"
          ? "Tier assigned — Starter-Kit captured"
          : "Tier changed — existing Starter-Kit preserved";
      toast.success(msg);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed");
    } finally {
      setTierSwap(null);
    }
  };

  const save = async () => {
    try {
      if (editing.id) await api.put(`/franchises/${editing.id}`, editing);
      else await api.post("/franchises", editing);
      toast.success(editing.id ? "Saved" : "Franchise created — Starter-Kit captured from tier");
      setEditing(null);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed");
    }
  };

  return (
    <div className="space-y-6" data-testid="franchises-page">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.25em] text-muted-foreground">Network</div>
          <h1 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight mt-2">Franchises</h1>
          <p className="text-sm text-muted-foreground mt-1">Service center spokes receiving stock from the hub. Each franchise owns a versioned Starter-Kit snapshot.</p>
        </div>
        <div className="flex items-center gap-2">
          <DateFilter value={dateRange} onChange={setDateRange} storageKey="df:franchises" />
          {canEdit && (
            <Button onClick={() => setEditing({ ...empty })} data-testid="new-franchise-btn"><Plus size={14} className="mr-2" /> New Franchise</Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filteredList.map((f) => (
          <div key={f.id} className="border border-border rounded-md p-5 bg-card lift-on-hover" data-testid={`franchise-card-${f.code}`}>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded bg-foreground text-background">
                <Storefront size={18} weight="duotone" />
              </div>
              <div>
                <div className="text-[11px] font-mono text-muted-foreground">{f.code}</div>
                <div className="font-medium">{f.name}</div>
              </div>
            </div>
            <div className="mt-4 space-y-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-2"><MapPin size={12} /> {f.city}, {f.state}</div>
              <div className="flex items-center gap-2"><Phone size={12} /> {f.contact_phone}</div>
              <div className="font-mono">{f.gstin}</div>
            </div>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              {(() => {
                const t = tierById(f.tier_id);
                return t ? (
                  <Badge variant="outline" className="text-[10px] gap-1" style={{ borderColor: t.color + "55", color: t.color }} data-testid={`tier-badge-${f.code}`}>
                    <Crown size={10} weight="duotone" />
                    {t.name} · {t.margin_percent}%
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px] text-muted-foreground">No tier</Badge>
                );
              })()}
              {f.starter_kit && (
                <Badge variant="outline" className="text-[10px] gap-1 text-emerald-600 dark:text-emerald-400 border-emerald-500/30" data-testid={`snap-badge-${f.code}`}>
                  <Package size={10} weight="duotone" />
                  Kit v{f.starter_kit.version || 1} · {f.starter_kit.items?.length || 0} items
                </Badge>
              )}
              {canAssignTier && (
                <Select value={f.tier_id || ""} onValueChange={(v) => handleTierSelect(f, v)}>
                  <SelectTrigger className="h-7 text-xs w-auto" data-testid={`tier-select-${f.code}`}><SelectValue placeholder="Change tier" /></SelectTrigger>
                  <SelectContent>
                    {tiers.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name} ({t.margin_percent}%)</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="mt-4 pt-4 border-t border-border flex items-center justify-between text-xs">
              <div>
                <div className="text-muted-foreground">Credit Limit</div>
                <div className="tabular-nums font-medium">{formatINR(f.credit_limit)}</div>
              </div>
              <div className="flex items-center gap-3">
                {canAssignTier && f.starter_kit && (
                  <button onClick={() => setKitFranchise(f)} className="text-muted-foreground hover:text-foreground flex items-center gap-1" data-testid={`edit-kit-${f.code}`}>
                    <PencilSimple size={11} /> Kit
                  </button>
                )}
                {canEdit && <button onClick={() => setEditing(f)} className="text-muted-foreground hover:text-foreground" data-testid={`edit-franchise-${f.code}`}>Edit →</button>}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Create / edit dialog */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle className="font-display">{editing?.id ? "Edit" : "New"} Franchise</DialogTitle></DialogHeader>
          {editing && (
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Code</Label><Input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} data-testid="fr-code" /></div>
              <div><Label>Name</Label><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} data-testid="fr-name" /></div>
              <div><Label>City</Label><Input value={editing.city} onChange={(e) => setEditing({ ...editing, city: e.target.value })} data-testid="fr-city" /></div>
              <div><Label>State</Label><Input value={editing.state} onChange={(e) => setEditing({ ...editing, state: e.target.value })} data-testid="fr-state" /></div>
              <div className="col-span-2"><Label>Address</Label><Input value={editing.address} onChange={(e) => setEditing({ ...editing, address: e.target.value })} /></div>
              <div><Label>GSTIN</Label><Input value={editing.gstin} onChange={(e) => setEditing({ ...editing, gstin: e.target.value })} /></div>
              <div><Label>Phone</Label><Input value={editing.contact_phone} onChange={(e) => setEditing({ ...editing, contact_phone: e.target.value })} /></div>
              <div><Label>Email</Label><Input value={editing.contact_email} onChange={(e) => setEditing({ ...editing, contact_email: e.target.value })} /></div>
              <div><Label>Credit Limit</Label><Input type="number" value={editing.credit_limit} onChange={(e) => setEditing({ ...editing, credit_limit: Number(e.target.value) })} /></div>
              <div className="col-span-2">
                <Label>Pricing Tier {!editing.id && <span className="text-[11px] text-muted-foreground">(Starter-Kit will be captured automatically)</span>}</Label>
                <Select value={editing.tier_id || ""} onValueChange={(v) => setEditing({ ...editing, tier_id: v })}>
                  <SelectTrigger data-testid="fr-tier"><SelectValue placeholder="Pick a tier — Buddy / Standard / Performax / Master" /></SelectTrigger>
                  <SelectContent>
                    {tiers.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name} ({t.margin_percent}% default margin · {(t.starter_kit_items?.length) || 0} kit items)</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={save} data-testid="save-franchise-btn">Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Tier swap confirmation */}
      <Dialog open={!!tierSwap} onOpenChange={(o) => !o && setTierSwap(null)}>
        <DialogContent data-testid="tier-swap-dialog">
          <DialogHeader>
            <DialogTitle className="font-display">Change tier — keep or replace Starter-Kit?</DialogTitle>
          </DialogHeader>
          {tierSwap && (
            <div className="space-y-3 text-sm">
              <p>
                <b>{tierSwap.franchise?.name}</b> is currently <b>{tierById(tierSwap.franchise?.tier_id)?.name || "—"}</b> with a versioned Starter-Kit
                (v{tierSwap.franchise?.starter_kit?.version || 1} · {tierSwap.franchise?.starter_kit?.items?.length || 0} items).
              </p>
              <p>Switching to <b>{tierById(tierSwap.newTierId)?.name}</b>. What should happen to the existing Starter-Kit?</p>
              <ul className="text-xs text-muted-foreground list-disc pl-5 space-y-1">
                <li><b>Keep</b> — only the tier label changes; this franchise's custom Starter-Kit stays intact.</li>
                <li><b>Replace</b> — overwrite the snapshot with the latest <b>{tierById(tierSwap.newTierId)?.name}</b> template (your edits will be lost).</li>
              </ul>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setTierSwap(null)} data-testid="tier-swap-cancel">Cancel</Button>
            <Button variant="outline" onClick={() => doAssignTier(tierSwap.franchise.id, tierSwap.newTierId, false)} data-testid="tier-swap-keep">Keep Existing Kit</Button>
            <Button onClick={() => doAssignTier(tierSwap.franchise.id, tierSwap.newTierId, true)} data-testid="tier-swap-replace">Replace with New Template</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Per-franchise Starter-Kit editor */}
      {kitFranchise && (
        <StarterKitDialog
          mode="franchise"
          franchise={kitFranchise}
          onClose={() => setKitFranchise(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}
