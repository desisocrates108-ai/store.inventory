import React, { useEffect, useState, useCallback } from "react";
import api, { formatINR, downloadPdf } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Truck, FilePdf, Copy, XCircle, Printer, MagnifyingGlass,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import EWayBillDialog from "@/components/EWayBillDialog";
import DateFilter, { dateQuery } from "@/components/DateFilter";

const STATUS_COLOR = {
  active: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30",
  cancelled: "bg-red-500/10 text-red-600 border-red-500/30",
  draft: "bg-zinc-500/10 text-zinc-600 border-zinc-500/30",
};

export default function EWayBills() {
  const { user } = useAuth();
  const canEdit = ["super_admin", "warehouse_manager", "hub_accountant"].includes(user?.role);
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({
    q: "",
    vehicle: "",
    transporter: "",
    status: "all",
  });
  const [dateRange, setDateRange] = useState({ preset: "all", from: "", to: "" });
  const [openEwb, setOpenEwb] = useState(null);
  const [franchiseMap, setFranchiseMap] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filters.q) params.set("q", filters.q);
    if (filters.vehicle) params.set("vehicle", filters.vehicle);
    if (filters.transporter) params.set("transporter", filters.transporter);
    if (filters.status && filters.status !== "all") params.set("status", filters.status);
    const dq = dateQuery(dateRange);
    if (dq.date_from) params.set("date_from", dq.date_from);
    if (dq.date_to) params.set("date_to", dq.date_to);
    try {
      const r = await api.get(`/eway-bills?${params.toString()}`);
      setList(r.data || []);
    } finally {
      setLoading(false);
    }
  }, [filters, dateRange]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    // Pre-fetch franchises for the filter (admins / accountants only)
    if (user?.role === "franchise_manager") return;
    api.get("/franchises").then((r) => {
      const m = {};
      (r.data || []).forEach((f) => { m[f.id] = f.name; });
      setFranchiseMap(m);
    });
  }, [user]);

  const handleDownload = async (ewb) => {
    await downloadPdf(`/eway-bills/${ewb.id}/pdf`, `${ewb.eway_number}.pdf`, { action: "download" });
  };

  const handlePrint = async (ewb) => {
    const ok = await downloadPdf(`/eway-bills/${ewb.id}/pdf`, `${ewb.eway_number}.pdf`, { action: "open" });
    if (!ok) toast.error("Could not open PDF for printing");
  };

  const handleDuplicate = async (ewb) => {
    if (!window.confirm(`Duplicate ${ewb.eway_number}? A new number will be issued.`)) return;
    try {
      const r = await api.post(`/eway-bills/${ewb.id}/duplicate`);
      toast.success(`Duplicated as ${r.data.eway_number}`);
      load();
    } catch (e) { /* interceptor toasts */ }
  };

  const handleCancel = async (ewb) => {
    const reason = window.prompt(`Cancel ${ewb.eway_number}? Enter reason:`, "");
    if (reason === null) return;
    try {
      await api.post(`/eway-bills/${ewb.id}/cancel`, { reason });
      toast.success("E-Way Bill cancelled");
      load();
    } catch (e) { /* interceptor */ }
  };

  return (
    <div className="space-y-6" data-testid="eway-bills-page">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="text-xs uppercase tracking-[0.25em] text-muted-foreground">Logistics</div>
          <h1 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight mt-2">
            E-Way Bills
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Search, print, duplicate or cancel any e-way bill. Generation happens from Tax Invoice or Delivery Challan.
          </p>
        </div>
        <DateFilter value={dateRange} onChange={setDateRange} storageKey="df:eway-bills" />
      </div>

      {/* Filters */}
      <div className="rounded-md border border-border p-3 grid grid-cols-1 md:grid-cols-5 gap-2 bg-card">
        <div className="md:col-span-2 relative">
          <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search EBN, invoice, vehicle, transporter…"
            className="pl-9"
            value={filters.q}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
            data-testid="ewb-search"
          />
        </div>
        <Input
          placeholder="Vehicle"
          value={filters.vehicle}
          onChange={(e) => setFilters((f) => ({ ...f, vehicle: e.target.value }))}
          data-testid="ewb-filter-vehicle"
        />
        <Input
          placeholder="Transporter"
          value={filters.transporter}
          onChange={(e) => setFilters((f) => ({ ...f, transporter: e.target.value }))}
          data-testid="ewb-filter-transporter"
        />
        <Select
          value={filters.status}
          onValueChange={(v) => setFilters((f) => ({ ...f, status: v }))}
        >
          <SelectTrigger data-testid="ewb-filter-status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="rounded-md border border-border overflow-hidden bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-3">EBN</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Franchise</th>
              <th className="px-4 py-3">Vehicle</th>
              <th className="px-4 py-3">Transporter</th>
              <th className="px-4 py-3">Valid Upto</th>
              <th className="px-4 py-3 text-right">Total</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.map((ewb) => (
              <tr
                key={ewb.id}
                className="border-t border-border hover:bg-muted/30 cursor-pointer"
                onClick={() => setOpenEwb(ewb)}
                data-testid={`ewb-row-${ewb.eway_number}`}
              >
                <td className="px-4 py-3 font-mono text-xs font-semibold">{ewb.eway_number}</td>
                <td className="px-4 py-3 text-xs">
                  <div className="font-mono">{ewb.document_number || "—"}</div>
                  <div className="text-muted-foreground">{ewb.document_type}</div>
                </td>
                <td className="px-4 py-3 text-xs">
                  {franchiseMap[ewb.franchise_id] || ewb.recipient?.name || "—"}
                </td>
                <td className="px-4 py-3 font-mono text-xs">{ewb.vehicle_number || "—"}</td>
                <td className="px-4 py-3 text-xs">{ewb.transporter_name || "—"}</td>
                <td className="px-4 py-3 text-xs font-mono">
                  {(ewb.valid_upto || "").slice(0, 10)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{formatINR(ewb.grand_total)}</td>
                <td className="px-4 py-3">
                  <Badge variant="outline" className={`text-[11px] ${STATUS_COLOR[ewb.status]}`}>
                    {ewb.status}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="inline-flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDownload(ewb)}
                      title="Download PDF"
                      data-testid={`ewb-download-${ewb.eway_number}`}
                    >
                      <FilePdf size={14} />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handlePrint(ewb)}
                      title="Print"
                      data-testid={`ewb-print-${ewb.eway_number}`}
                    >
                      <Printer size={14} />
                    </Button>
                    {canEdit && ewb.status !== "cancelled" && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDuplicate(ewb)}
                          title="Duplicate"
                          data-testid={`ewb-dup-${ewb.eway_number}`}
                        >
                          <Copy size={14} />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleCancel(ewb)}
                          title="Cancel"
                          data-testid={`ewb-cancel-${ewb.eway_number}`}
                        >
                          <XCircle size={14} className="text-red-500" />
                        </Button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr>
                <td colSpan={9} className="p-12 text-center text-muted-foreground" data-testid="ewb-empty">
                  <Truck size={32} className="mx-auto mb-2 opacity-50" />
                  {loading ? "Loading…" : "No e-way bills yet. Generate one from a Tax Invoice or Delivery Challan."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {openEwb && (
        <EWayBillDialog
          open={!!openEwb}
          onOpenChange={(o) => !o && setOpenEwb(null)}
          existing={openEwb}
          source={{
            type: openEwb.invoice_id ? "invoice" : "challan",
            id: openEwb.invoice_id || openEwb.challan_id,
            number: openEwb.document_number,
          }}
          onSaved={(updated) => {
            setOpenEwb(updated);
            load();
          }}
        />
      )}
    </div>
  );
}
