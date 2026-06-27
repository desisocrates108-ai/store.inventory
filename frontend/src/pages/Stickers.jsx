import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Plus, Tag, Copy, Trash, PencilSimple, Printer, ClockCounterClockwise } from "@phosphor-icons/react";

const TYPE_LABELS = {
  small_product: "Small Product",
  large_product: "Large Product",
  dealer: "Dealer",
  custom: "Custom",
  barcode_label: "Barcode Label",
  qr_label: "QR Label",
};

/**
 * Sticker Module landing page — template gallery + print history audit log.
 *
 * The designer (/stickers/designer) and batch-print (/stickers/batch-print)
 * pages are wholly independent — this page is essentially a directory.
 */
export default function Stickers() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [tab, setTab] = useState("templates");
  const [creating, setCreating] = useState(null); // {name, sticker_type, width_mm, height_mm}
  const [search, setSearch] = useState("");

  const loadAll = async () => {
    const [tplRes, jobRes] = await Promise.all([
      api.get("/sticker-templates"),
      api.get("/sticker-print-jobs?limit=200").catch(() => ({ data: [] })),
    ]);
    setTemplates(tplRes.data);
    setJobs(jobRes.data);
  };
  useEffect(() => { loadAll(); }, []);

  const filtered = templates.filter((t) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return t.name.toLowerCase().includes(q) || (t.sticker_type || "").includes(q);
  });

  const duplicate = async (t) => {
    try {
      await api.post(`/sticker-templates/${t.id}/duplicate`);
      toast.success("Template duplicated");
      loadAll();
    } catch (e) { toast.error("Failed"); }
  };
  const remove = async (t) => {
    if (!window.confirm(`Delete template "${t.name}"?`)) return;
    try {
      await api.delete(`/sticker-templates/${t.id}`);
      toast.success("Deleted");
      loadAll();
    } catch (e) { toast.error("Failed"); }
  };

  const createNew = async () => {
    if (!creating?.name) { toast.error("Name required"); return; }
    try {
      const r = await api.post("/sticker-templates", {
        name: creating.name,
        sticker_type: creating.sticker_type || "custom",
        width_mm: Number(creating.width_mm) || 50,
        height_mm: Number(creating.height_mm) || 30,
        dpi: 203,
        background_color: "#ffffff",
        canvas_json: { version: "6", objects: [] },
      });
      toast.success("Template created");
      navigate(`/stickers/designer/${r.data.id}`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed");
    }
  };

  return (
    <div className="space-y-6" data-testid="stickers-page">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.25em] text-muted-foreground">Label Engine</div>
          <h1 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight mt-2">Sticker Printing</h1>
          <p className="text-sm text-muted-foreground mt-1">Design, save and batch-print product / dealer / barcode labels. Independent module — works for any future label type.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild data-testid="batch-print-btn">
            <Link to="/stickers/batch-print"><Printer size={14} className="mr-2" />Batch Print</Link>
          </Button>
          <Button onClick={() => setCreating({ name: "", sticker_type: "small_product", width_mm: 50, height_mm: 30 })} data-testid="new-template-btn">
            <Plus size={14} className="mr-2" />New Template
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-border">
        <TabBtn active={tab === "templates"} onClick={() => setTab("templates")} testId="tab-templates">Templates ({templates.length})</TabBtn>
        <TabBtn active={tab === "history"} onClick={() => setTab("history")} testId="tab-history">Print History ({jobs.length})</TabBtn>
      </div>

      {tab === "templates" && (
        <div className="space-y-4">
          <Input placeholder="Search templates…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm" data-testid="search-templates" />
          {filtered.length === 0 ? (
            <div className="text-center py-16 border border-dashed border-border rounded-md bg-muted/20">
              <Tag size={36} weight="duotone" className="mx-auto text-muted-foreground" />
              <div className="mt-3 font-medium">No templates yet</div>
              <p className="text-xs text-muted-foreground mt-1">Click <b>New Template</b> to start designing.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {filtered.map((t) => (
                <div key={t.id} className="rounded-md border border-border bg-card p-4 hover:border-foreground/30 transition" data-testid={`template-card-${t.id}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{TYPE_LABELS[t.sticker_type] || t.sticker_type}</div>
                      <div className="font-medium truncate">{t.name}</div>
                    </div>
                    <Badge variant="outline" className="text-[10px] tabular-nums">{t.width_mm}×{t.height_mm}mm</Badge>
                  </div>
                  <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>Updated {(t.updated_at || t.created_at || "").slice(0, 10)}</span>
                    <span>{(t.canvas_json?.objects || []).length} objects</span>
                  </div>
                  <div className="mt-4 flex items-center gap-1 pt-3 border-t border-border">
                    <Button size="sm" variant="outline" onClick={() => navigate(`/stickers/designer/${t.id}`)} data-testid={`edit-tpl-${t.id}`}><PencilSimple size={12} className="mr-1" />Edit</Button>
                    <Button size="sm" variant="outline" onClick={() => duplicate(t)} title="Save As" data-testid={`dup-tpl-${t.id}`}><Copy size={12} /></Button>
                    <Button size="sm" variant="outline" onClick={() => navigate(`/stickers/batch-print?template_id=${t.id}`)} title="Print" data-testid={`print-tpl-${t.id}`}><Printer size={12} /></Button>
                    <span className="ml-auto" />
                    <Button size="sm" variant="ghost" onClick={() => remove(t)} title="Delete" data-testid={`del-tpl-${t.id}`}><Trash size={12} className="text-destructive" /></Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "history" && (
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/40">
              <tr className="text-left text-[10px] uppercase text-muted-foreground">
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Template</th>
                <th className="px-3 py-2">User</th>
                <th className="px-3 py-2">Strategy</th>
                <th className="px-3 py-2">Output</th>
                <th className="px-3 py-2 text-right">Products</th>
                <th className="px-3 py-2 text-right">Stickers</th>
                <th className="px-3 py-2">Printer</th>
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">No print history yet — anything printed via Batch Print will appear here.</td></tr>
              )}
              {jobs.map((j) => (
                <tr key={j.id} className="border-t border-border" data-testid={`job-${j.id}`}>
                  <td className="px-3 py-2 whitespace-nowrap">{(j.created_at || "").replace("T", " ").slice(0, 16)}</td>
                  <td className="px-3 py-2">{j.template_name}</td>
                  <td className="px-3 py-2">{j.user_name}</td>
                  <td className="px-3 py-2 capitalize">{(j.qty_strategy || "").replace("_", " ")}</td>
                  <td className="px-3 py-2 uppercase">{j.output_format}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{j.product_count}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{j.total_stickers}</td>
                  <td className="px-3 py-2 text-muted-foreground">{j.printer_label || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={!!creating} onOpenChange={(o) => !o && setCreating(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle className="font-display">New Sticker Template</DialogTitle></DialogHeader>
          {creating && (
            <div className="space-y-3">
              <div><Label>Name</Label><Input value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} placeholder="e.g. Performax Spark Plug Sticker" data-testid="new-tpl-name" /></div>
              <div><Label>Type</Label>
                <Select value={creating.sticker_type} onValueChange={(v) => setCreating({ ...creating, sticker_type: v })}>
                  <SelectTrigger data-testid="new-tpl-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(TYPE_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Width (mm)</Label><Input type="number" value={creating.width_mm} onChange={(e) => setCreating({ ...creating, width_mm: e.target.value })} data-testid="new-tpl-width" /></div>
                <div><Label>Height (mm)</Label><Input type="number" value={creating.height_mm} onChange={(e) => setCreating({ ...creating, height_mm: e.target.value })} data-testid="new-tpl-height" /></div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(null)}>Cancel</Button>
            <Button onClick={createNew} data-testid="new-tpl-create">Create & Open Designer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TabBtn({ active, onClick, children, testId }) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className={`px-3 py-2 text-sm border-b-2 -mb-px transition ${active ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}
