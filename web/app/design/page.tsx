"use client";

/**
 * The living style guide at /design.
 *
 * This page exists so the design system cannot drift silently: every token and
 * every primitive is rendered from the same source the product uses, so a
 * change to globals.css or components/ds shows up here immediately. When adding
 * a primitive, add it here too — a component that is not on this page is a
 * component nobody else on the team knows exists.
 *
 * It is dev-facing, unlinked from the rail, and ships with the app on purpose:
 * the fastest way to answer "what does this look like in the real theme" is to
 * open it in the real app.
 */

import { useState } from "react";

import { Info } from "@/components/icons";
import {
  Bento,
  Callout,
  Chip,
  Code,
  Distribution,
  Divider,
  Eyebrow,
  Grid,
  Kbd,
  Metric,
  MetricRow,
  Delta,
  Meter,
  Panel,
  RiskGauge,
  Segmented,
  SeverityChip,
  SeverityLegend,
  Skeleton,
  SkeletonRows,
  Slab,
  Sparkline,
  Stack,
  Toolbar,
  ToolbarSep,
  type Severity,
} from "@/components/ds";
import { Page, PageHeader } from "@/components/kit";
import { Button } from "@/components/ui/button";

const SURFACES = ["bg-ground", "bg-base", "bg-surface", "bg-surface-raised", "bg-surface-overlay"];
const LINES = ["bg-line", "bg-line-strong", "bg-line-loud"];
const INKS = ["text-ink-strong", "text-ink", "text-ink-muted", "text-ink-faint"];
const SEVERITIES: Severity[] = ["none", "low", "medium", "high", "critical"];
const SERIES = ["bg-data-1", "bg-data-2", "bg-data-3", "bg-data-4", "bg-data-5", "bg-data-6"];
const TYPE = [
  ["display-xl", "text-display-xl", "Blast radius"],
  ["display", "text-display", "Blast radius"],
  ["heading", "text-heading", "Blast radius"],
  ["subheading", "text-subheading", "Blast radius"],
  ["body-lg", "text-body-lg", "Every answer carries its evidence."],
  ["body", "text-body", "Every answer carries its evidence."],
  ["body-sm", "text-body-sm", "Every answer carries its evidence."],
  ["caption", "text-caption", "Every answer carries its evidence."],
  ["micro", "text-micro", "RESOLUTION 94%"],
];

function Swatch({ className, name }: { className: string; name: string }) {
  return (
    <div className="min-w-0">
      <div className={`h-12 rounded-control border border-line ${className}`} />
      <div className="mt-1.5 truncate font-mono text-micro text-ink-muted">{name}</div>
    </div>
  );
}

export default function DesignPage() {
  const [seg, setSeg] = useState("a");
  return (
    <Page>
      <PageHeader
        eyebrow="Reference"
        title="Design system"
        sub="Every token and primitive the product is built from, rendered live. If something looks wrong here, it is wrong everywhere."
      />
      <Stack>
        <Slab title="Colour" description="Three tiers: a raw palette, semantic names, then shadcn's variables. Components only ever touch the semantic names.">
          <Grid cols={2}>
            <Panel title="Surfaces" note="the ladder — depth is one rung up, never a drop shadow">
              <Grid cols={5}>
                {SURFACES.map((c) => (
                  <Swatch key={c} className={c} name={c.replace("bg-", "")} />
                ))}
              </Grid>
              <Divider className="my-4" label="Lines" />
              <Grid cols={3}>
                {LINES.map((c) => (
                  <Swatch key={c} className={c} name={c.replace("bg-", "")} />
                ))}
              </Grid>
            </Panel>
            <Panel title="Ink" note="four steps; anything below ink-faint is decoration, not text">
              <ul className="space-y-2">
                {INKS.map((c) => (
                  <li key={c} className={`flex items-baseline gap-3 ${c}`}>
                    <span className="w-28 shrink-0 font-mono text-micro">{c.replace("text-", "")}</span>
                    <span className="text-body">What breaks if I change this?</span>
                  </li>
                ))}
              </ul>
            </Panel>
          </Grid>

          <Grid cols={2} className="mt-[var(--stack-gap)]">
            <Panel tone="brand" title="Brand — chrome" note="violet. primary action, active nav, links, focus, selection.">
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm">Primary</Button>
                <Button size="sm" variant="outline">
                  Outline
                </Button>
                <Button size="sm" variant="ghost">
                  Ghost
                </Button>
                <Chip tone="brand" dot>
                  brand
                </Chip>
              </div>
              <p className="mt-3 text-body-sm text-ink-muted">
                The accent is deliberately cool. In a blast-radius tool the warm ramp belongs to the data, so chrome cannot borrow it.
              </p>
            </Panel>
            <Panel title="Severity — data" note="the thermal ramp. nothing else in the product is orange or red.">
              <div className="flex flex-wrap gap-1.5">
                {SEVERITIES.map((s) => (
                  <SeverityChip key={s} severity={s} />
                ))}
              </div>
              <SeverityLegend className="mt-3" omit={[]} />
              <Divider className="my-4" label="Categorical" />
              <Grid cols={6}>
                {SERIES.map((c) => (
                  <Swatch key={c} className={c} name={c.replace("bg-", "")} />
                ))}
              </Grid>
            </Panel>
          </Grid>
        </Slab>

        <Slab title="Typography" description="Barlow Condensed for display and readouts, Inter for UI and prose, JetBrains Mono for anything a machine produced.">
          <Panel>
            <ul className="space-y-3">
              {TYPE.map(([name, cls, sample]) => (
                <li key={name} className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="w-24 shrink-0 font-mono text-micro text-ink-muted">{name}</span>
                  <span className={cls}>{sample}</span>
                </li>
              ))}
            </ul>
            <Divider className="my-4" />
            <div className="flex flex-wrap items-center gap-3 text-body-sm">
              <Code>graph.impact(symbol)</Code>
              <span className="text-ink-muted">
                press <Kbd>⌘K</Kbd> to jump
              </span>
              <Eyebrow>eyebrow label</Eyebrow>
            </div>
          </Panel>
        </Slab>

        <Slab title="Containers" description="Three shapes, no more: Panel for data, Bento for navigation, Slab for a titled band.">
          <Grid cols={3}>
            <Panel title="Panel" note="default tone">
              <p className="text-body-sm text-ink-muted">Dense, nestable, scroll-safe. The default for anything you read.</p>
              <Panel tone="raised" title="Nested" className="mt-3">
                <p className="text-caption text-ink-muted">One rung up the ladder, lit from above.</p>
              </Panel>
            </Panel>
            <Bento>
              <div className="text-body text-ink-strong">Bento</div>
              <div className="mt-1 text-body-sm text-ink-muted">18px radius, hover lift. For choosing where to go, not for reading.</div>
            </Bento>
            <Panel tone="recessed" title="Recessed">
              <p className="text-body-sm text-ink-muted">For inputs and read-only output wells.</p>
            </Panel>
          </Grid>
          <Toolbar className="mt-[var(--stack-gap)]">
            <Eyebrow>Toolbar</Eyebrow>
            <ToolbarSep />
            <Segmented
              label="Example"
              value={seg}
              onChange={setSeg}
              options={[
                { value: "a", label: "Graph" },
                { value: "b", label: "Table" },
                { value: "c", label: "JSON" },
              ]}
            />
            <ToolbarSep />
            <Button size="sm" variant="outline">
              Run
            </Button>
          </Toolbar>
        </Slab>

        <Slab title="Data display" description="Numbers are instrument readouts: loud value, quiet label, tabular figures.">
          <Grid cols="main-aside">
            <Panel title="Metrics">
              <Grid cols={3}>
                <Metric label="Impacted" value="1,284" hint="symbols" />
                <Metric label="Tests to run" value="37" tone="text-pass" aside={<Sparkline points={[3, 9, 6, 14, 11, 18, 24]} />} />
                <Metric label="Graph time" value="41ms" hint="2 queries" />
              </Grid>
              <Divider className="my-4" label="Rows" />
              <MetricRow label="Definite breakage" value="12" tone="text-sev-critical" />
              <MetricRow label="Likely" value="44" tone="text-sev-high" />
              <MetricRow label="Possible" value="131" tone="text-sev-medium" />
              <Divider className="my-4" label="Deltas" />
              <div className="flex gap-4">
                <Delta value={12} goodWhen="down" />
                <Delta value={-8} goodWhen="down" />
                <Delta value={0} />
              </div>
              <Divider className="my-4" label="Proportions" />
              <Meter value={0.72} label="Resolution" className="mb-3" marker={0.9} />
              <Distribution
                parts={SERIES.map((c, i) => ({ key: c, value: 6 - i, className: c }))}
              />
            </Panel>
            <Panel title="Risk">
              <RiskGauge score={78} caption="signature change to a load-bearing symbol" />
            </Panel>
          </Grid>
        </Slab>

        <Slab title="States" description="Loading matches the shape of what is coming, so nothing reflows when it arrives.">
          <Grid cols={3}>
            <Panel title="Skeletons">
              <Skeleton className="mb-2 h-6 w-2/3" />
              <SkeletonRows rows={4} />
            </Panel>
            <Panel title="Callouts">
              <Stack>
                <Callout tone="info" icon={<Info aria-hidden />}>
                  Coverage is inferred from test imports, not from a coverage run.
                </Callout>
                <Callout tone="warn">Resolution is 61% — treat the possible tier as a hint.</Callout>
                <Callout tone="fail" action={<Button size="sm" variant="outline" className="h-7">Retry</Button>}>
                  FalkorDB is unreachable.
                </Callout>
              </Stack>
            </Panel>
            <Panel title="Chips">
              <div className="flex flex-wrap gap-1.5">
                <Chip>neutral</Chip>
                <Chip tone="brand">brand</Chip>
                <Chip tone="pass" dot>
                  pass
                </Chip>
                <Chip tone="warn" dot>
                  warn
                </Chip>
                <Chip tone="fail" dot>
                  fail
                </Chip>
                <Chip tone="info">info</Chip>
              </div>
            </Panel>
          </Grid>
        </Slab>
      </Stack>
    </Page>
  );
}
