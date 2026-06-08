import React, { useEffect, useState } from "react";
import { CalendarBlank, X } from "@phosphor-icons/react";

/**
 * Global Date Filter component (V2.1)
 * Persists selection to localStorage per `storageKey` so filters survive nav.
 *
 * Props:
 *   value: { preset, from, to }
 *   onChange: (next) => void
 *   storageKey: string  (e.g. "df:indents")
 */
const PRESETS = [
  { id: "all",       label: "All time" },
  { id: "today",     label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "7d",        label: "Last 7 Days" },
  { id: "30d",       label: "Last 30 Days" },
  { id: "this_month",label: "This Month" },
  { id: "last_month",label: "Last Month" },
  { id: "custom",    label: "Custom Range" },
];

const pad = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function presetToRange(preset) {
  const now = new Date();
  const start = new Date(now); start.setHours(0,0,0,0);
  switch (preset) {
    case "today":
      return { from: fmt(start), to: fmt(start) };
    case "yesterday": {
      const y = new Date(start); y.setDate(y.getDate() - 1);
      return { from: fmt(y), to: fmt(y) };
    }
    case "7d": {
      const f = new Date(start); f.setDate(f.getDate() - 6);
      return { from: fmt(f), to: fmt(start) };
    }
    case "30d": {
      const f = new Date(start); f.setDate(f.getDate() - 29);
      return { from: fmt(f), to: fmt(start) };
    }
    case "this_month": {
      const f = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: fmt(f), to: fmt(start) };
    }
    case "last_month": {
      const f = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const t = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: fmt(f), to: fmt(t) };
    }
    default:
      return { from: "", to: "" };
  }
}

export default function DateFilter({ value, onChange, storageKey }) {
  const [open, setOpen] = useState(false);
  const v = value || { preset: "all", from: "", to: "" };

  useEffect(() => {
    if (!storageKey) return;
    const raw = localStorage.getItem(storageKey);
    if (raw && (!value || value.preset == null)) {
      try { onChange(JSON.parse(raw)); } catch (_e) { /* ignore */ }
    }
  }, [storageKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = (next) => {
    onChange(next);
    if (storageKey) localStorage.setItem(storageKey, JSON.stringify(next));
  };

  const pick = (preset) => {
    if (preset === "custom") {
      apply({ preset, from: v.from || "", to: v.to || "" });
      return;
    }
    if (preset === "all") {
      apply({ preset: "all", from: "", to: "" });
      setOpen(false);
      return;
    }
    const r = presetToRange(preset);
    apply({ preset, ...r });
    setOpen(false);
  };

  const label = v.preset === "all"
    ? "All time"
    : v.preset === "custom"
      ? (v.from && v.to ? `${v.from} → ${v.to}` : "Custom")
      : (PRESETS.find(p => p.id === v.preset)?.label || "All time");

  return (
    <div className="relative" data-testid={`date-filter-${storageKey || "global"}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-muted"
        data-testid="date-filter-trigger"
      >
        <CalendarBlank size={14} />
        <span>{label}</span>
        {v.preset !== "all" && (
          <span
            onClick={(e) => { e.stopPropagation(); apply({ preset: "all", from: "", to: "" }); }}
            className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-muted-foreground/20"
            data-testid="date-filter-clear"
          >
            <X size={10} />
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 z-20 w-72 rounded-md border border-border bg-popover p-3 shadow-lg" data-testid="date-filter-panel">
            <div className="grid grid-cols-2 gap-1">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => pick(p.id)}
                  className={`rounded px-2 py-1.5 text-left text-xs ${v.preset === p.id ? "bg-foreground text-background" : "hover:bg-muted"}`}
                  data-testid={`date-preset-${p.id}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {v.preset === "custom" && (
              <div className="mt-3 space-y-2 border-t border-border pt-3">
                <div>
                  <label className="text-[11px] text-muted-foreground">From</label>
                  <input
                    type="date"
                    value={v.from || ""}
                    onChange={(e) => apply({ ...v, from: e.target.value })}
                    className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
                    data-testid="date-from-input"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-muted-foreground">To</label>
                  <input
                    type="date"
                    value={v.to || ""}
                    onChange={(e) => apply({ ...v, to: e.target.value })}
                    className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
                    data-testid="date-to-input"
                  />
                </div>
                <button
                  onClick={() => setOpen(false)}
                  className="w-full rounded bg-foreground py-1.5 text-sm text-background"
                  data-testid="date-apply-btn"
                >Apply</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Helper for callers: build URL query string for backend
export function dateQuery(value) {
  if (!value) return {};
  if (value.preset === "all" || (!value.from && !value.to)) return {};
  const q = {};
  if (value.from) q.date_from = value.from;
  if (value.to) q.date_to = value.to;
  return q;
}
