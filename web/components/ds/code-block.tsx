"use client";

/**
 * CodeBlock — the one way to show a block of code, a diff, a payload or a log tail.
 *
 * Highlighting is deliberately absent. Everything this product shows in a code
 * block is either JSON the agent passed to a tool, a unified diff, or captured
 * stdout — none of which a syntax highlighter improves, and all of which a
 * 400 KB highlighter bundle would slow down. A diff gets line tinting, which is
 * the only colour that carries meaning here, and that costs nothing.
 *
 * The block always scrolls horizontally inside itself. Long lines must never
 * widen the page.
 */

import * as React from "react";

import { Check, Copy } from "@/components/icons";
import { cn } from "@/lib/utils";

/** How long the copy button stays in its confirmed state. */
const COPIED_MS = 1400;

export function useCopy(text: string) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const copy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      /* clipboard denied (insecure origin, or the user said no) — the text is still selectable */
    }
  }, [text]);
  return { copied, copy };
}

export function CopyButton({ text, className, label = "Copy" }: { text: string; className?: string; label?: string }) {
  const { copied, copy } = useCopy(text);
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      onClick={copy}
      data-hit
      aria-label={copied ? "Copied" : label}
      className={cn(
        "inline-flex items-center gap-1 rounded-control border border-line px-1.5 py-1 font-mono text-micro uppercase",
        "text-ink-muted transition-colors duration-[var(--dur-fast)] hover:border-line-loud hover:text-ink-strong",
        copied && "border-pass/40 text-pass",
        className,
      )}
    >
      <Icon className="size-3.5" />
      {copied ? "Copied" : label}
    </button>
  );
}

export interface CodeBlockProps extends Omit<React.ComponentProps<"div">, "children" | "title"> {
  code: string;
  /** Shown in the header rail — a filename, a tool name, "stdout". */
  title?: React.ReactNode;
  /** Right side of the header rail. */
  action?: React.ReactNode;
  /** Tints +/- lines. Only pass this for a real unified diff. */
  diff?: boolean;
  /** Caps the height and scrolls; omit to let the block grow. */
  maxHeight?: number | string;
  /** Hides the copy button — for a two-line payload where it is just noise. */
  noCopy?: boolean;
  /** Soft-wraps instead of scrolling. For prose-ish output like an error message. */
  wrap?: boolean;
}

export function CodeBlock({
  code,
  title,
  action,
  diff,
  maxHeight,
  noCopy,
  wrap,
  className,
  ...rest
}: CodeBlockProps) {
  const text = code ?? "";
  const showHeader = Boolean(title || action || !noCopy);
  return (
    <div className={cn("overflow-hidden rounded-nested border border-line bg-ground/60", className)} {...rest}>
      {showHeader && (
        <div className="flex items-center gap-2 border-b border-line bg-surface/60 px-2.5 py-1.5">
          {title && <span className="min-w-0 truncate font-mono text-micro uppercase text-ink-muted">{title}</span>}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {action}
            {!noCopy && <CopyButton text={text} />}
          </div>
        </div>
      )}
      <div className="overflow-x-auto" style={maxHeight === undefined ? undefined : { maxHeight, overflowY: "auto" }}>
        <pre
          className={cn(
            "min-w-full p-2.5 font-mono text-code leading-[1.55] text-ink",
            wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
          )}
        >
          {diff ? <DiffLines code={text} /> : <code>{text}</code>}
        </pre>
      </div>
    </div>
  );
}

/**
 * A unified diff with its added and removed lines tinted.
 *
 * Tinting uses `pass`/`fail` rather than the severity ramp: a removed line is
 * not "critical", it is just removed, and spending the thermal ramp on it would
 * dilute the one place that ramp means risk.
 */
function DiffLines({ code }: { code: string }) {
  const lines = React.useMemo(() => code.split("\n"), [code]);
  return (
    <code className="block">
      {lines.map((line, i) => {
        const head = line[0];
        const meta = line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ");
        const added = head === "+" && !line.startsWith("+++");
        const removed = head === "-" && !line.startsWith("---");
        return (
          <span
            key={i}
            className={cn(
              "block px-2.5 -mx-2.5",
              added && "bg-pass/10 text-pass",
              removed && "bg-fail/10 text-fail",
              meta && "text-ink-faint",
            )}
          >
            {line || " "}
          </span>
        );
      })}
    </code>
  );
}

/**
 * A small key/value payload — what a tool was called with.
 *
 * JSON.stringify of a three-key object wastes four lines on braces. This renders
 * the pairs inline and falls back to a real code block only when a value is
 * genuinely structured.
 */
export function PayloadGrid({ data, className }: { data: Record<string, unknown>; className?: string }) {
  const entries = Object.entries(data ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!entries.length) return null;
  return (
    <dl className={cn("grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-code", className)}>
      {entries.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-ink-faint">{k}</dt>
          <dd className="min-w-0 break-words text-ink">
            {typeof v === "object" ? JSON.stringify(v) : String(v)}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
