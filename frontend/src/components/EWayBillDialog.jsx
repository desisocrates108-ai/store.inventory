import React, { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Truck, FilePdf, ArrowsClockwise } from "@phosphor-icons/react";
import { toast } from "sonner";
import api, { formatINR, downloadPdf } from "@/lib/api";

const TRANSPORT_MODES = [
  { value: "road", label: "Road" },
  { value: "rail", label: "Rail" },
  { value: "air", label: "Air" },
  { value: "ship", label: "Ship" },
];
const REASONS = [
  { value: "supply", label: "Supply" },
  { value: "sales_return", label: "Sales Return" },
  { value: "export", label: "Export" },
  { value: "import", label: "Import" },
  { value: "job_work", label: "Job Work" },
  { value: "skd", label: "SKD" },
  { value: "ckd", label: "CKD" },
  { value: "others", label: "Others" },
];

/**
 * EWayBillDialog
 * ---------------
 * Reusable dialog mounted from Tax Invoice and Delivery Challan pages.
 *
 * Props:
 *   open, onOpenChange — controlled state
 *   source: { type: 'invoice' | 'challan', id, number, snapshot? }
 *   existing: existing e-way bill doc (for view / edit / regenerate)
 *   onSaved(ewb): callback fired after a successful create/update
 *
 * The "Auto-filled" section is read-only — supplier, recipient, items, totals.
 * The user only edits transport details (vehicle, transporter, distance, ...).
 */
export default function EWayBillDialog({
  open, onOpenChange, source, existing, onSaved,
}) {
  const [preview, setPreview] = useState(null); // auto-fill preview (party + items)
  const [form, setForm] = useState({
    vehicle_number: "",
    transporter_name: "",
    transporter_gstin: "",
    transporter_id: "",
    lr_number: "",
    distance_km: 0,
    transport_mode: "road",
    vehicle_type: "Regular",
    reason: "supply",
    remarks: "",
  });
  const [saving, setSaving] = useState(false);
  const [ewb, setEwb] = useState(existing || null);

  // Hydrate form + preview whenever dialog opens
  useEffect(() => {
    if (!open) return;
    setEwb(existing || null);
    if (existing) {
      setPreview({
        supplier: existing.supplier,
        recipient: existing.recipient,
        line_items: existing.line_items,
        subtotal: existing.subtotal,
        cgst_total: existing.cgst_total,
        sgst_total: existing.sgst_total,
        igst_total: existing.igst_total,
        grand_total: existing.grand_total,
        document_number: existing.document_number,
        document_date: existing.document_date,
      });
      setForm({
        vehicle_number: existing.vehicle_number || "",
        transporter_name: existing.transporter_name || "",
        transporter_gstin: existing.transporter_gstin || "",
        transporter_id: existing.transporter_id || "",
        lr_number: existing.lr_number || "",
        distance_km: existing.distance_km || 0,
        transport_mode: existing.transport_mode || "road",
        vehicle_type: existing.vehicle_type || "Regular",
        reason: existing.reason || "supply",
        remarks: existing.remarks || "",
      });
      return;
    }
    // Fresh create — load snapshot preview by fetching the source doc
    if (!source) return;
    const path =
      source.type === "invoice"
        ? `/tax-invoices/${source.id}`
        : `/delivery-challans/${source.id}`;
    api.get(path).then((r) => {
      const d = r.data || {};
      // For invoice we already have line_items / supplier / recipient via backend snapshot;
      // for DC we approximate (server does the canonical snapshot on POST).
      setPreview({
        document_number:
          d.invoice_number || d.dc_number || d.id,
        document_date: (d.invoice_date || d.created_at || "").slice(0, 10),
        billing_name: d.billing_name || d.franchise_name || "",
        billing_address: d.shipping_address || d.billing_address || "",
        billing_gstin: d.billing_gstin || "",
        line_items: (d.line_items || []).map((li) => ({
          description: li.description || li.product_name || "",
          sku: li.sku || "",
          hsn: li.hsn || "",
          qty: li.qty || li.allocated_qty || li.requested_qty || 0,
          unit: li.unit || "PCS",
          taxable_value: li.taxable_value ?? (li.unit_price || 0) * (li.allocated_qty || li.requested_qty || li.qty || 0),
          line_total: li.line_total || ((li.unit_price || 0) * (li.allocated_qty || li.requested_qty || li.qty || 0)),
        })),
        subtotal: d.subtotal || d.total_amount || 0,
        cgst_total: d.cgst_total || d.cgst || 0,
        sgst_total: d.sgst_total || d.sgst || 0,
        igst_total: d.igst_total || d.igst || 0,
        grand_total: d.grand_total || 0,
      });
    });
  }, [open, source, existing]);

  const updateField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (!form.vehicle_number.trim()) {
      toast.error("Vehicle Number is required");
      return;
    }
    if (!form.transporter_name.trim()) {
      toast.error("Transporter Name is required");
      return;
    }
    setSaving(true);
    try {
      let resp;
      if (ewb && ewb.id) {
        // Update existing — only transport details change
        resp = await api.put(`/eway-bills/${ewb.id}`, form);
        toast.success(`E-Way Bill ${resp.data.eway_number} updated`);
      } else {
        const path =
          source.type === "invoice"
            ? `/eway-bills/from-invoice/${source.id}`
            : `/eway-bills/from-challan/${source.id}`;
        resp = await api.post(path, form);
        toast.success(`E-Way Bill ${resp.data.eway_number} generated`);
      }
      setEwb(resp.data);
      onSaved?.(resp.data);
    } catch (e) {
      // global interceptor will toast; nothing extra to do here
    } finally {
      setSaving(false);
    }
  };

  const handleDownload = async () => {
    if (!ewb?.id) return;
    await downloadPdf(
      `/eway-bills/${ewb.id}/pdf`,
      `${ewb.eway_number}.pdf`,
      { action: "download" },
    );
  };

  const handleRegenerate = async () => {
    // "Regenerate" = save edits and re-download fresh PDF
    await handleSave();
    setTimeout(handleDownload, 500);
  };

  const isLocked = ewb?.status === "cancelled";
  const isEdit = !!ewb;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-4xl max-h-[90vh] overflow-y-auto"
        data-testid="ewb-dialog"
      >
        <DialogHeader>
          <DialogTitle className="font-display text-xl flex items-center gap-2">
            <Truck size={20} />
            {isEdit ? `E-Way Bill — ${ewb.eway_number}` : "Generate E-Way Bill"}
            {ewb && (
              <Badge
                variant="outline"
                className={
                  ewb.status === "active"
                    ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/30"
                    : ewb.status === "cancelled"
                    ? "bg-red-500/10 text-red-600 border-red-500/30"
                    : ""
                }
              >
                {ewb.status?.toUpperCase()}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {preview && (
          <div className="space-y-5">
            {/* ---- Auto-filled snapshot ---- */}
            <section className="rounded border border-border bg-muted/20 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  Auto-filled from {source?.type === "invoice" ? "Tax Invoice" : "Delivery Challan"}
                </div>
                <div className="font-mono text-xs">
                  {preview.document_number}{" "}
                  <span className="text-muted-foreground">
                    · {preview.document_date}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div className="rounded border border-border p-3 bg-background">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                    From (Supplier)
                  </div>
                  <div className="font-medium" data-testid="ewb-supplier-name">
                    {ewb?.supplier?.name || "Servall Pvt Ltd"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    GSTIN: {ewb?.supplier?.gstin || "—"}
                  </div>
                </div>
                <div className="rounded border border-border p-3 bg-background">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                    To (Recipient)
                  </div>
                  <div className="font-medium" data-testid="ewb-recipient-name">
                    {ewb?.recipient?.name || preview.billing_name}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    GSTIN: {ewb?.recipient?.gstin || preview.billing_gstin || "—"}
                  </div>
                  <div className="text-xs text-muted-foreground line-clamp-2">
                    {ewb?.recipient?.address || preview.billing_address}
                  </div>
                </div>
              </div>

              <div className="rounded border border-border overflow-hidden bg-background">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40">
                    <tr className="text-left text-muted-foreground">
                      <th className="px-3 py-2">Item</th>
                      <th className="px-3 py-2">HSN</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                      <th className="px-3 py-2 text-right">Taxable</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(preview.line_items || []).map((li, i) => (
                      <tr key={i} className="border-t border-border" data-testid={`ewb-item-${i}`}>
                        <td className="px-3 py-2">
                          {li.description}
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {li.sku}
                          </div>
                        </td>
                        <td className="px-3 py-2 font-mono">{li.hsn || "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{li.qty}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatINR(li.taxable_value)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatINR(li.line_total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex justify-end">
                <div className="w-72 space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span className="tabular-nums">{formatINR(preview.subtotal)}</span>
                  </div>
                  {preview.cgst_total > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">CGST</span>
                      <span className="tabular-nums">{formatINR(preview.cgst_total)}</span>
                    </div>
                  )}
                  {preview.sgst_total > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">SGST</span>
                      <span className="tabular-nums">{formatINR(preview.sgst_total)}</span>
                    </div>
                  )}
                  {preview.igst_total > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">IGST</span>
                      <span className="tabular-nums">{formatINR(preview.igst_total)}</span>
                    </div>
                  )}
                  <div className="flex justify-between border-t border-border pt-1 mt-1 font-semibold">
                    <span>Grand Total</span>
                    <span
                      className="tabular-nums"
                      data-testid="ewb-grand-total"
                    >
                      {formatINR(preview.grand_total)}
                    </span>
                  </div>
                </div>
              </div>
            </section>

            {/* ---- Transport details ---- */}
            <section className="rounded border border-border p-4 space-y-3">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                Transport Details (you fill these)
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div>
                  <Label htmlFor="ewb-vehicle">Vehicle Number *</Label>
                  <Input
                    id="ewb-vehicle"
                    value={form.vehicle_number}
                    placeholder="e.g. KA01AB1234"
                    onChange={(e) => updateField("vehicle_number", e.target.value.toUpperCase())}
                    disabled={isLocked}
                    data-testid="ewb-vehicle"
                  />
                </div>
                <div>
                  <Label htmlFor="ewb-transporter">Transporter Name *</Label>
                  <Input
                    id="ewb-transporter"
                    value={form.transporter_name}
                    onChange={(e) => updateField("transporter_name", e.target.value)}
                    disabled={isLocked}
                    data-testid="ewb-transporter"
                  />
                </div>
                <div>
                  <Label htmlFor="ewb-tr-gstin">Transporter GSTIN</Label>
                  <Input
                    id="ewb-tr-gstin"
                    value={form.transporter_gstin}
                    onChange={(e) => updateField("transporter_gstin", e.target.value.toUpperCase())}
                    disabled={isLocked}
                    data-testid="ewb-transporter-gstin"
                  />
                </div>
                <div>
                  <Label htmlFor="ewb-tr-id">Transporter ID (15-char)</Label>
                  <Input
                    id="ewb-tr-id"
                    value={form.transporter_id}
                    onChange={(e) => updateField("transporter_id", e.target.value)}
                    disabled={isLocked}
                    data-testid="ewb-transporter-id"
                  />
                </div>
                <div>
                  <Label htmlFor="ewb-lr">LR / Doc Number</Label>
                  <Input
                    id="ewb-lr"
                    value={form.lr_number}
                    onChange={(e) => updateField("lr_number", e.target.value)}
                    disabled={isLocked}
                    data-testid="ewb-lr"
                  />
                </div>
                <div>
                  <Label htmlFor="ewb-distance">Approx. Distance (km)</Label>
                  <Input
                    id="ewb-distance"
                    type="number"
                    min={0}
                    value={form.distance_km}
                    onChange={(e) => updateField("distance_km", parseFloat(e.target.value) || 0)}
                    disabled={isLocked}
                    data-testid="ewb-distance"
                  />
                </div>
                <div>
                  <Label>Transport Mode</Label>
                  <Select
                    value={form.transport_mode}
                    onValueChange={(v) => updateField("transport_mode", v)}
                    disabled={isLocked}
                  >
                    <SelectTrigger data-testid="ewb-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TRANSPORT_MODES.map((m) => (
                        <SelectItem key={m.value} value={m.value} data-testid={`ewb-mode-${m.value}`}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Reason</Label>
                  <Select
                    value={form.reason}
                    onValueChange={(v) => updateField("reason", v)}
                    disabled={isLocked}
                  >
                    <SelectTrigger data-testid="ewb-reason">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {REASONS.map((r) => (
                        <SelectItem key={r.value} value={r.value} data-testid={`ewb-reason-${r.value}`}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="md:col-span-2">
                  <Label htmlFor="ewb-remarks">Remarks</Label>
                  <Input
                    id="ewb-remarks"
                    value={form.remarks}
                    onChange={(e) => updateField("remarks", e.target.value)}
                    disabled={isLocked}
                    data-testid="ewb-remarks"
                  />
                </div>
              </div>
            </section>

            {ewb && (
              <div className="rounded border border-border p-3 text-xs grid grid-cols-2 gap-3 bg-muted/20">
                <div>
                  <div className="text-muted-foreground">EBN</div>
                  <div className="font-mono">{ewb.eway_number}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Valid Upto</div>
                  <div className="font-mono">
                    {(ewb.valid_upto || "").slice(0, 19).replace("T", " ")}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Provider</div>
                  <div className="font-mono">{ewb.provider}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Generated By</div>
                  <div>{ewb.created_by_name || "—"}</div>
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 flex-wrap">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="ewb-close-btn"
          >
            Close
          </Button>
          {ewb && (
            <Button
              variant="outline"
              onClick={handleDownload}
              data-testid="ewb-download-btn"
            >
              <FilePdf size={14} className="mr-1" />
              Download PDF
            </Button>
          )}
          {ewb && !isLocked && (
            <Button
              variant="outline"
              onClick={handleRegenerate}
              disabled={saving}
              data-testid="ewb-regenerate-btn"
            >
              <ArrowsClockwise size={14} className="mr-1" />
              Save &amp; Regenerate
            </Button>
          )}
          {!isLocked && (
            <Button
              onClick={handleSave}
              disabled={saving}
              data-testid="ewb-save-btn"
            >
              {ewb ? "Save Changes" : "Generate E-Way Bill"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
