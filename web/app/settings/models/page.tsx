"use client";

/**
 * Models — bring your own provider key.
 *
 * The security shape of this page is the whole design, so it is stated once
 * here and enforced everywhere below:
 *
 *  - A key enters the browser exactly once, in a `type="password"` field, and
 *    leaves on a single PUT. It is never put in React state that outlives the
 *    submit, never in localStorage, never in a URL, and no route anywhere
 *    returns it. What comes back is `last4` and nothing else.
 *  - Writes are loopback-only, enforced twice: once by the API, and again by
 *    the Next proxy — because the API's own check sees the proxy's address, not
 *    the visitor's, so on a LAN deployment the proxy is the guard that holds.
 *    The page says this out loud rather than letting a 403 be a mystery.
 *  - An environment key always wins over a stored one, and cannot be cleared
 *    from here. That key belongs to whoever runs the server; a web page must
 *    not be able to revoke it.
 *
 * Everything is listed, including providers with no key — the catalogue *is*
 * the answer to "what can I plug in?".
 */

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Callout, Chip, ErrorNote, Head, Label, Mono, Page, Sheet, Skeleton, Stack } from "@/components/gt";
import { ArrowRight, Check, CircleAlert, Github, Key, Loader2, Prohibit, Sparkles, Trash, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { api, type ProviderStatus } from "@/lib/api";
import { useQuery } from "@/lib/hooks";
import { cn } from "@/lib/utils";

function SourceChip({ p }: { p: ProviderStatus }) {
  if (!p.configured) return <Chip>no key</Chip>;
  if (p.source === "local") return <Chip tone="info">local</Chip>;
  return <Chip tone="pass">{p.source === "env" ? "env" : "stored"}</Chip>;
}

function ProviderSheet({ p, onChanged }: { p: ProviderStatus; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /**
   * The only place a key exists in this app. Cleared on submit, on cancel and
   * on error — there is no path where it survives the interaction that needed
   * it, and nothing else ever reads this variable.
   */
  const [key, setKey] = useState("");

  const fromEnv = p.source === "env";

  const reset = () => {
    setKey("");
    setEditing(false);
    setError(undefined);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = key.trim();
    if (value.length < 8) {
      setError("That is too short to be an API key.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api.providerSetKey(p.id, value);
      reset();
      onChanged();
      toast.success(`${p.label} key saved`, { description: "Stored on the server at 0600. It is never sent back." });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setKey(""); // a rejected key is still a key: do not leave it sitting in the field
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.providerClearKey(p.id);
      onChanged();
      toast.success(`${p.label} key removed`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      tone={p.configured ? "library" : "void"}
      className={cn(!p.configured && "[&_.gt-sheet]:border-dashed")}
      title={p.label}
      note={`${p.models.length} model${p.models.length === 1 ? "" : "s"} · ${p.wire} wire`}
      action={
        <>
          {p.configured && p.last4 && <Mono className="text-[11px] text-ink-dim">…{p.last4}</Mono>}
          <SourceChip p={p} />
        </>
      }
      bodyClassName="flex flex-col gap-4"
    >
      <ul className="flex flex-wrap gap-1.5">
        {p.models.map((m) => (
          <li key={m.id}>
            <span className={cn("inline-flex items-center gap-1.5 border px-2 py-1", p.configured ? "border-line-loud bg-deep" : "border-line")} title={m.id}>
              <span className={cn("font-mono text-[11.5px]", p.configured ? "text-ink" : "text-ink-dim")}>{m.label}</span>
              {m.reasoning && <Sparkles className="size-3 text-mark" aria-label="reasoning model" />}
              {m.note && <span className="text-[10.5px] text-ink-faint">{m.note}</span>}
            </span>
          </li>
        ))}
      </ul>

      <div className="h-px bg-line" aria-hidden />

      {p.keyless ? (
        <p className="text-[12.5px] leading-relaxed text-ink-dim">
          Needs no key — it talks to a server you run. Point it somewhere else with <Mono className="text-ink">{p.env_vars[0] ?? "OLLAMA_HOST"}</Mono>. Never
          chosen automatically: a local server nobody started would turn every question into a connection error.
        </p>
      ) : fromEnv ? (
        <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-dim">
          <Prohibit className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            Set from the environment
            {p.env_vars.length > 0 && (
              <>
                {" ("}
                {p.env_vars.map((v, i) => (
                  <span key={v}>
                    {i > 0 && " or "}
                    <Mono className="text-ink">{v}</Mono>
                  </span>
                ))}
                {")"}
              </>
            )}
            . An environment key belongs to whoever runs the server, so it wins over anything stored here and cannot be cleared from a browser.
          </span>
        </p>
      ) : editing ? (
        <form onSubmit={save} className="flex flex-col gap-2">
          <Label htmlFor={`key-${p.id}`}>API key</Label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={`key-${p.id}`}
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={p.key_hint}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              // A pasted secret has no business in a password manager's capture prompt.
              data-1p-ignore
              data-lpignore="true"
              className="gt-field min-w-0 flex-1"
              // The field only exists because the user just clicked "Add key"; focus follows the intent.
              autoFocus
            />
            <Button type="submit" className="h-10" disabled={busy || !key.trim()}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />} Save
            </Button>
            <Button type="button" variant="ghost" className="h-10" onClick={reset} disabled={busy}>
              <X className="size-4" aria-hidden /> Cancel
            </Button>
          </div>
          <p className="text-[11.5px] text-ink-faint">Sent once to the API on this machine, written to disk owner-only, and never returned by any route.</p>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant={p.configured ? "outline" : "default"} size="sm" onClick={() => setEditing(true)} disabled={busy}>
            <Key className="size-4" aria-hidden /> {p.configured ? "Replace key" : "Add key"}
          </Button>
          {p.configured && p.source === "stored" && (
            <Button variant="ghost" size="sm" onClick={clear} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash className="size-4" aria-hidden />} Remove
            </Button>
          )}
          <a
            href={p.docs}
            target="_blank"
            rel="noreferrer noopener"
            className="ml-auto inline-flex items-center gap-1 text-[12px] text-ink-dim underline-offset-2 hover:text-mark hover:underline"
          >
            Get a key <ArrowRight className="size-3.5" aria-hidden />
          </a>
        </div>
      )}

      {error && <ErrorNote error={error} />}
    </Sheet>
  );
}

export default function ModelSettingsPage() {
  const q = useQuery("providers", api.providers);
  const providers = q.data?.providers ?? [];
  const ready = providers.filter((p) => p.configured && !p.keyless);
  const def = q.data?.default ?? null;
  const defKnown = def ? providers.some((p) => p.models.some((m) => m.id === def)) : false;

  return (
    <Page>
      <Head
        no="Settings · Models"
        title={
          <>
            Bring <em>your own key.</em>
          </>
        }
        lead="Ask runs on whichever provider you give a key to. Keys are stored by the API on this machine, owner-only, and are never sent back to the browser."
        meta={q.data ? [{ fig: String(ready.length), label: ready.length === 1 ? "provider ready" : "providers ready" }] : undefined}
      >
        <Button asChild variant="outline" size="sm">
          <Link href="/">
            Back to repositories <ArrowRight className="size-4" aria-hidden />
          </Link>
        </Button>
      </Head>

      <Stack>
        {q.error ? (
          <ErrorNote error={q.error} onRetry={q.reload} />
        ) : q.loading && !q.data ? (
          <Stack className="gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </Stack>
        ) : (
          <>
            <Sheet no="01 · Status" title="Status" tone="capture" bodyClassName="flex flex-col gap-3">
              <p className="text-[13.5px] leading-relaxed text-ink">
                {ready.length === 0 ? (
                  <>
                    No provider is configured, so Ask falls back to its keyword router: it still answers from the graph, but it picks the tool by pattern instead of
                    reasoning about your question.
                  </>
                ) : (
                  <>
                    <Mono className="text-mark">{ready.length}</Mono> provider{ready.length === 1 ? "" : "s"} ready —{" "}
                    {ready.map((p, i) => (
                      <span key={p.id}>
                        {i > 0 && ", "}
                        {p.label}
                      </span>
                    ))}
                    . Pick a model per question in Ask; this is only the default.
                  </>
                )}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="gt-label">Default</span>
                {def ? <Mono className="text-[13px] text-ink">{def}</Mono> : <Chip>none</Chip>}
              </div>
              {def && !defKnown && (
                // Worth saying rather than hiding: the server's configured model id is not one this build knows
                // about, so a request naming no model may be rejected by the provider.
                <Callout tone="warn" icon={<CircleAlert className="size-4 text-warn" aria-hidden />}>
                  The server&apos;s default <Mono>{def}</Mono> is not in the catalogue below. It comes from <Mono>AFTERSHOCK_MODEL</Mono> (or the{" "}
                  <Mono>model</Mono> setting) — if the provider rejects it, choose a model explicitly in Ask or correct the setting.
                </Callout>
              )}
            </Sheet>

            <Callout tone="info" icon={<Key className="size-4 text-info" aria-hidden />}>
              Keys can only be added or removed from the machine the API runs on. On a shared deployment, set the environment variable listed on each provider
              instead — the browser form will be refused, by design.
            </Callout>

            <div className="grid gap-[clamp(14px,2vw,24px)] lg:grid-cols-2">
              {providers.map((p) => (
                <ProviderSheet key={p.id} p={p} onChanged={q.reload} />
              ))}
            </div>

            <p className="flex items-center gap-1.5 text-[12px] text-ink-dim">
              <Github className="size-3.5" aria-hidden />
              Missing a provider? Any OpenAI-compatible endpoint works on the <Mono>openai</Mono> wire — adding one is an entry in{" "}
              <Mono>aftershock/providers.py</Mono>.
            </p>
          </>
        )}
      </Stack>
    </Page>
  );
}
