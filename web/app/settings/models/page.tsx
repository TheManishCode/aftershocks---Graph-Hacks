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
 * the answer to "what can I plug in?", and hiding the unconfigured ones would
 * make the page useless to the person who came here to configure one.
 */

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import {
  ArrowRight,
  Check,
  CircleAlert,
  Github,
  Key,
  Loader2,
  Prohibit,
  Sparkles,
  Trash,
  X,
} from "@/components/icons";
import {
  Callout,
  Chip,
  Code,
  Divider,
  ErrorNote,
  Eyebrow,
  Mono,
  Page,
  PageHeader,
  Panel,
  SkeletonRows,
  Stack,
} from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type ProviderStatus } from "@/lib/api";
import { useQuery } from "@/lib/hooks";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- */

function SourceChip({ p }: { p: ProviderStatus }) {
  if (!p.configured) return <Chip tone="neutral">no key</Chip>;
  if (p.source === "local")
    return (
      <Chip tone="info" dot>
        local
      </Chip>
    );
  return (
    <Chip tone="pass" dot>
      {p.source === "env" ? "env" : "stored"}
    </Chip>
  );
}

function ProviderCard({ p, onChanged }: { p: ProviderStatus; onChanged: () => void }) {
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
    <Panel
      tone={p.configured ? "default" : "bare"}
      className={cn(!p.configured && "border-line border-dashed")}
      title={p.label}
      note={`${p.models.length} model${p.models.length === 1 ? "" : "s"} · ${p.wire} wire`}
      action={
        <div className="flex items-center gap-2">
          {p.configured && p.last4 && <Mono className="text-caption text-ink-muted">…{p.last4}</Mono>}
          <SourceChip p={p} />
        </div>
      }
      bodyClassName="flex flex-col gap-3"
    >
      <ul className="flex flex-wrap gap-1.5">
        {p.models.map((m) => (
          <li key={m.id}>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-control border px-2 py-1",
                p.configured ? "border-line-strong bg-surface" : "border-line",
              )}
              title={m.id}
            >
              <span className={cn("text-caption", p.configured ? "text-ink-strong" : "text-ink-muted")}>{m.label}</span>
              {m.reasoning && <Sparkles className="size-3 text-brand" aria-label="reasoning model" />}
              {m.note && <span className="text-micro text-ink-faint">{m.note}</span>}
            </span>
          </li>
        ))}
      </ul>

      <Divider />

      {p.keyless ? (
        <p className="text-caption text-ink-muted">
          Needs no key — it talks to a server you run. Point it somewhere else with{" "}
          <Code>{p.env_vars[0] ?? "OLLAMA_HOST"}</Code>. Never chosen automatically: a local server nobody started
          would turn every question into a connection error.
        </p>
      ) : fromEnv ? (
        <p className="flex items-start gap-2 text-caption text-ink-muted">
          <Prohibit className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            Set from the environment
            {p.env_vars.length > 0 && (
              <>
                {" ("}
                {p.env_vars.map((v, i) => (
                  <span key={v}>
                    {i > 0 && " or "}
                    <Code>{v}</Code>
                  </span>
                ))}
                {")"}
              </>
            )}
            . An environment key belongs to whoever runs the server, so it wins over anything stored here and cannot
            be cleared from a browser.
          </span>
        </p>
      ) : editing ? (
        <form onSubmit={save} className="flex flex-col gap-2">
          <Label htmlFor={`key-${p.id}`}>
            <Eyebrow>API key</Eyebrow>
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id={`key-${p.id}`}
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={p.key_hint}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              // A pasted secret has no business in the browser's form-restore cache.
              data-1p-ignore
              data-lpignore="true"
              className="min-w-0 flex-1 font-mono"
              // The field only exists because the user just clicked "Add key"; focus follows the intent.
              autoFocus
            />
            <Button type="submit" disabled={busy || !key.trim()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Save
            </Button>
            <Button type="button" variant="ghost" onClick={reset} disabled={busy}>
              <X className="size-4" /> Cancel
            </Button>
          </div>
          <p className="text-caption text-ink-muted">
            Sent once to the API on this machine, written to disk owner-only, and never returned by any route.
          </p>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant={p.configured ? "outline" : "default"} onClick={() => setEditing(true)} disabled={busy}>
            <Key className="size-4" /> {p.configured ? "Replace key" : "Add key"}
          </Button>
          {p.configured && p.source === "stored" && (
            <Button variant="ghost" onClick={clear} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash className="size-4" />} Remove
            </Button>
          )}
          <a
            href={p.docs}
            target="_blank"
            rel="noreferrer noopener"
            className="ml-auto inline-flex items-center gap-1 text-caption text-ink-muted underline-offset-2 hover:text-brand hover:underline"
          >
            Get a key <ArrowRight className="size-3.5" aria-hidden />
          </a>
        </div>
      )}

      {error && <ErrorNote error={error} />}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

export default function ModelSettingsPage() {
  const q = useQuery("providers", api.providers);
  const providers = q.data?.providers ?? [];
  const ready = providers.filter((p) => p.configured && !p.keyless);
  const def = q.data?.default ?? null;
  const defKnown = def ? providers.some((p) => p.models.some((m) => m.id === def)) : false;

  return (
    <Page>
      <PageHeader
        eyebrow="Settings"
        title="Models"
        sub="Ask runs on whichever provider you give a key to. Keys are stored by the API on this machine, owner-only, and are never sent back to the browser."
      >
        <Button asChild variant="outline">
          <Link href="/">
            Back to repositories <ArrowRight className="size-4" />
          </Link>
        </Button>
      </PageHeader>

      <Stack>
        {q.error ? (
          <ErrorNote error={q.error} onRetry={q.reload} />
        ) : q.loading && !q.data ? (
          <SkeletonRows rows={6} />
        ) : (
          <>
            <Panel title="Status" bodyClassName="flex flex-col gap-2">
              <p className="text-body-sm text-ink">
                {ready.length === 0 ? (
                  <>
                    No provider is configured, so Ask falls back to its keyword router: it still answers from the
                    graph, but it picks the tool by pattern instead of reasoning about your question.
                  </>
                ) : (
                  <>
                    <Mono className="text-ink-strong">{ready.length}</Mono> provider
                    {ready.length === 1 ? "" : "s"} ready —{" "}
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
                <Eyebrow>Default</Eyebrow>
                {def ? <Mono className="text-body-sm text-ink-strong">{def}</Mono> : <Chip tone="neutral">none</Chip>}
              </div>
              {def && !defKnown && (
                // Worth saying rather than hiding: the server's configured model id is not one this build knows
                // about, so a request naming no model may be rejected by the provider.
                <Callout tone="warn" icon={<CircleAlert className="text-warn" aria-hidden />}>
                  The server&apos;s default <Mono>{def}</Mono> is not in the catalogue below. It comes from{" "}
                  <Code>AFTERSHOCK_MODEL</Code> (or the <Code>model</Code> setting) — if the provider rejects it,
                  choose a model explicitly in Ask or correct the setting.
                </Callout>
              )}
            </Panel>

            <Callout tone="info" icon={<Key className="text-info" aria-hidden />}>
              Keys can only be added or removed from the machine the API runs on. On a shared deployment, set the
              environment variable listed on each provider instead — the browser form will be refused, by design.
            </Callout>

            {providers.map((p) => (
              <ProviderCard key={p.id} p={p} onChanged={q.reload} />
            ))}

            <p className="flex items-center gap-1.5 text-caption text-ink-muted">
              <Github className="size-3.5" aria-hidden />
              Missing a provider? Any OpenAI-compatible endpoint works on the <Mono>openai</Mono> wire — adding one is
              an entry in <Mono>aftershock/providers.py</Mono>.
            </p>
          </>
        )}
      </Stack>
    </Page>
  );
}
