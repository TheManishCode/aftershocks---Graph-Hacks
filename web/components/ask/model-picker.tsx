"use client";

/**
 * Picks the model one question runs on.
 *
 * Only providers with a key are offered. Listing a model you cannot call is a
 * trap: it looks like a choice, then the server quietly falls back to the
 * router and the answer is thinner for a reason nobody can see. Providers
 * without a key are represented by exactly one row — a link to Settings.
 *
 * "Server default" is a real option, not a placeholder: it sends no `model` at
 * all, which is what you want when the operator has configured one centrally.
 */

import { Check, ChevronDown, Settings, Sparkles } from "@/components/icons";
import { Chip, Mono } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Effort, ProviderStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

export const EFFORTS: Effort[] = ["low", "medium", "high"];

export interface ModelChoice {
  /** provider-qualified id, or null for the server's default */
  id: string | null;
  label: string;
  provider?: string;
  reasoning?: boolean;
}

/** The flat list of callable models, with the server default first. */
export function choices(providers: ProviderStatus[], serverDefault: string | null): ModelChoice[] {
  const out: ModelChoice[] = [
    { id: null, label: serverDefault ? `Server default · ${serverDefault}` : "Server default" },
  ];
  for (const p of providers) {
    if (!p.configured) continue;
    for (const m of p.models) out.push({ id: m.id, label: m.label, provider: p.label, reasoning: m.reasoning });
  }
  return out;
}

export function ModelPicker({
  providers,
  serverDefault,
  value,
  onChange,
  disabled,
}: {
  providers: ProviderStatus[];
  serverDefault: string | null;
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  const all = choices(providers, serverDefault);
  const current = all.find((c) => c.id === value) ?? all[0];
  const configured = providers.filter((p) => p.configured);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled} className="h-7 gap-1.5 px-2 text-ink-muted hover:text-ink-strong">
          <Sparkles className="size-3.5" aria-hidden />
          <span className="max-w-[18ch] truncate text-caption">{current.id ? current.label : "Default model"}</span>
          <ChevronDown className="size-3" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[22rem] p-1">
        <ul role="listbox" aria-label="Model" className="max-h-[22rem] overflow-y-auto">
          <li>
            <Row
              selected={value === null}
              onSelect={() => onChange(null)}
              label="Server default"
              note={serverDefault ?? "none configured — answers come from the router"}
            />
          </li>
          {configured.map((p) => (
            <li key={p.id}>
              <p className="px-2 pt-2 pb-1 font-mono text-micro uppercase text-ink-faint">{p.label}</p>
              <ul>
                {p.models.map((m) => (
                  <li key={m.id}>
                    <Row
                      selected={value === m.id}
                      onSelect={() => onChange(m.id)}
                      label={m.label}
                      note={m.note || m.model}
                      badge={m.reasoning ? "reasons" : undefined}
                    />
                  </li>
                ))}
              </ul>
            </li>
          ))}
          {configured.length === 0 && (
            <li className="px-2 py-3">
              <p className="text-caption text-ink-muted">
                No provider has a key, so every question goes to the deterministic router — one tool, matched by
                pattern.
              </p>
              <Button asChild size="sm" variant="outline" className="mt-2 w-full">
                <a href="/settings/models">
                  <Settings className="size-3.5" aria-hidden /> Add a key
                </a>
              </Button>
            </li>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function Row({
  selected,
  onSelect,
  label,
  note,
  badge,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  note?: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors",
        "hover:bg-accent/60",
        selected && "bg-accent/40",
      )}
    >
      <Check className={cn("size-3.5 shrink-0", selected ? "text-brand" : "opacity-0")} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-sm text-ink-strong">{label}</span>
        {note && <Mono className="block truncate text-micro text-ink-faint">{note}</Mono>}
      </span>
      {badge && (
        <Chip tone="brand" size="sm">
          {badge}
        </Chip>
      )}
    </button>
  );
}
