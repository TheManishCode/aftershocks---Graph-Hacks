"use client";

import { useEffect, useRef, useState } from "react";

import { FileCode, Code, X } from "@/components/icons";
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { splitId, symName } from "@/lib/format";
import { useDebounced, useQuery } from "@/lib/hooks";
import { cn } from "@/lib/utils";

/**
 * Pick one or more symbols (or files) by searching the graph. Free text is allowed too: Enter adds whatever is typed,
 * and the API resolves it (a qualified name, `path::qname`, or a file path) or answers with candidates.
 */
export function SymbolPicker({
  repo,
  value,
  onChange,
  multiple = true,
  files = true,
  placeholder = "Search a function, class or file…",
  id,
}: {
  repo: string;
  value: string[];
  onChange: (v: string[]) => void;
  multiple?: boolean;
  files?: boolean;
  placeholder?: string;
  id?: string;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const q = useDebounced(text.trim(), 160);
  const res = useQuery(q && open ? `pick:${repo}:${q}` : null, () => api.search(repo, q, 12));
  const input = useRef<HTMLInputElement>(null);

  const add = (ref: string) => {
    if (!ref) return;
    onChange(multiple ? [...value.filter((v) => v !== ref), ref] : [ref]);
    setText("");
    setOpen(multiple);
    input.current?.focus();
  };
  const remove = (ref: string) => onChange(value.filter((v) => v !== ref));

  useEffect(() => {
    if (!text) setOpen(false);
  }, [text]);

  const syms = res.data?.symbols ?? [];
  const fs = files ? (res.data?.files ?? []) : [];

  return (
    <Popover open={open && !!q} onOpenChange={setOpen}>
      <Command shouldFilter={false} className="overflow-visible bg-transparent">
        <PopoverAnchor asChild>
          <div
            className="gt-field flex min-h-11 flex-wrap items-center gap-1.5 px-2 py-1.5"
            onClick={() => input.current?.focus()}
          >
            {value.map((v) => {
              const [file, qn] = splitId(v);
              return (
                <span key={v} className="inline-flex max-w-full items-center gap-1 border border-mark/70 bg-mark/10 py-0.5 pr-1 pl-2 font-mono text-[12px] text-mark">
                  <span className="truncate" title={v}>
                    {qn || file}
                  </span>
                  <button type="button" className="p-0.5 text-mark/70 hover:text-mark" onClick={() => remove(v)} aria-label={`Remove ${v}`}>
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
            <input
              ref={input}
              id={id}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Backspace" && !text && value.length) remove(value[value.length - 1]);
                // cmdk handles Enter on a highlighted item; with no results, Enter takes the text as typed
                if (e.key === "Enter" && text.trim() && !syms.length && !fs.length) {
                  e.preventDefault();
                  add(text.trim());
                }
              }}
              placeholder={value.length && multiple ? "Add another…" : value.length ? "" : placeholder}
              className="h-7 min-w-[12ch] flex-1 bg-transparent font-mono text-[13px] text-ink outline-none placeholder:font-sans placeholder:text-ink-faint"
              autoComplete="off"
              spellCheck={false}
              aria-autocomplete="list"
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="w-(--radix-popover-trigger-width) min-w-[min(520px,90vw)] p-0"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <CommandList className="max-h-[340px]">
            <CommandEmpty>{res.loading ? "Searching…" : "No match. Press Enter to use it as typed."}</CommandEmpty>
            {syms.length > 0 && (
              <CommandGroup heading="Symbols">
                {syms.map((s) => (
                  <CommandItem key={s.id} value={s.id} onSelect={() => add(s.id)}>
                    <Code className={cn("size-4", s.is_test ? "text-info" : "text-ink-faint")} />
                    <span className="truncate font-mono text-ink">{symName(s.qname)}</span>
                    <span className="ml-auto truncate pl-3 font-mono text-[11px] text-ink-dim">
                      {s.kind} · {s.file}:{s.line}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {fs.length > 0 && (
              <CommandGroup heading="Files">
                {fs.map((f) => (
                  <CommandItem key={f.path} value={`file:${f.path}`} onSelect={() => add(f.path)}>
                    <FileCode className="size-4 text-ink-faint" />
                    <span className="truncate font-mono text-ink">{f.path}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </PopoverContent>
      </Command>
    </Popover>
  );
}
