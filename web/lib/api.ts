/**
 * Typed client for the Aftershock REST API (aftershock/api.py), called through the same-origin proxy in
 * app/api/v1/[...path]. Types mirror real responses; fields the UI doesn't read are left out.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export interface Receipts {
  queries: number;
  graph_ms: number;
  total_ms: number;
}

export type Change = "body" | "signature" | "rename" | "delete";
export type Tier = "definite" | "likely" | "possible";
export type Level = "low" | "medium" | "high" | "critical";

export interface Repo {
  name: string;
  url: string;
  files: number | null;
  symbols: number | null;
  calls: number | null;
  resolution_rate: number | null;
  indexed_at: number | null;
  commit: string | null;
  history_commits: number | null;
  indexing: boolean;
}

export interface SymbolBrief {
  id: string;
  name: string;
  qname: string;
  kind: string;
  file: string;
  line: number;
  is_test?: boolean;
  pagerank?: number;
  fan_in?: number;
}

export interface Hotspot {
  path: string;
  lang: string;
  loc: number;
  churn: number;
  commits: number;
  complexity: number;
  pagerank: number;
  fan_in: number;
  community: number;
}

export interface Overview {
  repo: {
    name: string;
    url?: string;
    commit?: string;
    files: number;
    symbols: number;
    calls: number;
    call_sites: number;
    resolved_sites: number;
    resolution_rate: number;
    external_sites?: number;
    repo_resolution_rate?: number;
    indexed_at: number;
    edge_mix: Record<string, number>;
    langs: Record<string, number>;
    unresolved_top: [string, number][];
    history_commits?: number;
  };
  counts: { files: number; symbols: number; calls: number; imports: number };
  hotspots: Hotspot[];
  central: (SymbolBrief & { betweenness: number; complexity: number })[];
  /** A strongly connected import component, with one concrete loop through it (first file repeated last). */
  cycles: { files: string[]; size: number; example: string[] }[];
  cycle_count: number;
  dead_code: (SymbolBrief & { loc: number; category: string; reason: string })[];
  subsystems: { id: number; name: string; size: number; files: string[] }[];
  links: { src: number; dst: number; weight: number }[];
}

export interface EdgeStep {
  from: { id: string; name: string; file: string; line: number; kind?: string };
  to: { id: string; name: string; file: string; line: number; kind?: string };
  type: string;
  how?: string;
  confidence?: number;
  lines?: number[];
  verdict?: string;
}

export interface Impacted {
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  p: number;
  tier: Tier;
  hop: number;
  is_test: boolean;
  via?: number;
  seed: string;
  path: { from: string; to: string; label?: string; type: string; how?: string; confidence?: number; file?: string; lines?: number[]; verdict?: string; via?: string }[];
  verdict?: string;
  pagerank?: number;
  /** a recorded test run executed this symbol's seed (COVERS edge) */
  runtime?: boolean;
}

export interface Seed {
  id: string;
  name: string;
  change: Change;
  file: string;
  line: number;
  kind: string;
  note?: string;
  found: boolean;
}

export interface Owner {
  email: string;
  name: string;
  commits: number;
  last?: number;
  file_count?: number;
  files?: string[];
}

export interface ImportOnly {
  file: string;
  imports: string;
  names: string[] | null;
  line: number | null;
}

export interface Cochange {
  path: string;
  strength: number;
  count: number;
  via?: string[];
}

export interface Problem {
  ref: string;
  error: string;
  candidates?: SymbolBrief[];
}

export interface Impact {
  seeds: Seed[];
  impacted: Impacted[];
  tests: Impacted[];
  files: { file: string; p: number; symbols: number; tests: number; min_hop: number }[];
  untested_seeds: Seed[];
  hidden_coupling: Cochange[];
  import_only?: ImportOnly[];
  owners: Owner[];
  risk: {
    score: number;
    level: Level;
    components: { expected_breakages: number; definite: number; files: number; seed_centrality: number; untested_seeds: number };
  };
  counts: { impacted: number; tests: number; files: number; definite: number; likely: number; possible: number };
  hops: number;
  max_depth: number;
  truncated: boolean;
  /** tests found through recorded per-test coverage */
  runtime_tests?: number;
  note?: string;
  problems?: Problem[];
  markdown?: string;
  /** absent when the impact is embedded in a diff result, which carries its own */
  receipts?: Receipts;
  error?: string;
}

export interface SymbolChange {
  id: string;
  file: string;
  qname: string;
  kind: string;
  change: Change | "added";
  line: number;
  old_signature?: string;
  new_signature?: string;
  renamed_to?: string;
}

export interface DiffResult {
  changes: { base: string; head: string; files_changed: string[]; files_added: string[]; files_removed: string[]; symbols: SymbolChange[] };
  impact: Impact | null;
  markdown: string;
  receipts: Receipts;
}

export interface PathResult {
  found: boolean;
  /** "file" when no symbol chain exists but the files are linked by imports; `files` is then the import chain */
  level?: "symbol" | "file";
  files?: string[];
  direction?: string;
  hops?: number;
  confidence?: number;
  steps: EdgeStep[];
  summary?: string;
  error?: string;
  problems?: Problem[];
  receipts: Receipts;
}

export interface Suspect {
  id: string;
  name: string;
  file: string;
  line: number;
  score: number;
  failed: number;
  passed: number;
  changed: boolean;
  failing_tests: string[];
  hops: number;
  path: { from: string; to: string; type: string; how?: string; confidence?: number; lines?: number[] }[];
  /** "coverage" when its passing-test count comes from recorded per-test coverage (D26) */
  basis?: "coverage" | "static";
  /** the score in words: how many failing / passing tests reach it, the Ochiai arithmetic, the hop count */
  why?: string;
}

export interface CulpritResult {
  failing: string[];
  suspects: Suspect[];
  problems?: Problem[];
  unexplained?: string[];
  method: string;
  receipts: Receipts;
}

export interface SymbolDetail {
  symbol: SymbolBrief & {
    end_line: number;
    signature?: string;
    params?: string[];
    complexity: number;
    loc: number;
    doc?: string;
    exported?: boolean;
    decorators?: string[];
    returns?: string;
    bases?: string[];
    lang: string;
    fan_out?: number;
    betweenness?: number;
    community?: number;
  };
  callers: Neighbor[];
  callees: Neighbor[];
  receipts: Receipts;
}

export interface Neighbor {
  id: string;
  name: string;
  file: string;
  line: number;
  type: string;
  how?: string;
  confidence?: number;
  lines?: number[];
}

export interface FileDetail {
  file: { path: string; lang: string; loc: number; churn?: number; commits?: number; last_change?: number; authors?: number; is_test?: boolean };
  symbols: SymbolBrief[];
  imports: { path: string; names?: string[]; line?: number }[];
  importers: { path: string; names?: string[]; line?: number }[];
  externals: string[];
  cochange: Cochange[];
  owners: Owner[];
  receipts: Receipts;
}

export interface AskStep {
  tool: string;
  input: Record<string, unknown>;
  summary?: string;
  error?: string | boolean;
  receipts?: Receipts;
}

export interface AskResult {
  answer: string;
  steps: AskStep[];
  mode: "claude" | "router";
  route?: string;
  hint?: string;
  /** the model that actually answered; absent on the router path */
  model?: string;
  provider?: string;
  usage?: { input: number; output: number; cache_read: number };
}

/** How hard a reasoning model should think. Ignored by models that do not reason. */
export type Effort = "low" | "medium" | "high";

export interface AskPayload {
  question: string;
  /** provider-qualified, e.g. "openrouter:anthropic/claude-sonnet-5". Omit to use the server's default. */
  model?: string;
  effort?: Effort;
}

/* ---- model providers (D27) ------------------------------------------------ */

export interface ProviderModel {
  /** provider-qualified id — what you send as `model` */
  id: string;
  /** the provider's own name for it */
  model: string;
  label: string;
  note: string;
  reasoning: boolean;
}

export interface ProviderStatus {
  id: string;
  label: string;
  wire: "anthropic" | "openai";
  docs: string;
  key_hint: string;
  /** a local server that needs no key */
  keyless: boolean;
  configured: boolean;
  /** "env" keys belong to the operator and cannot be cleared from the UI; "stored" ones can */
  source: "env" | "stored" | "local" | "";
  /** the last four characters of the key — never the key itself */
  last4: string;
  env_vars: string[];
  models: ProviderModel[];
}

/** Writing or clearing a key acknowledges only; re-read `/providers` for the new state. */
export interface ProviderAck {
  ok: boolean;
  provider: string;
}

export type RunMode = "diff" | "targets" | "all" | "coverage";

export interface RunRequest {
  mode: RunMode;
  targets?: string[];
  rev?: string;
}

/** One pytest outcome row, as the plugin reports it; setup/teardown rows appear only when they fail or skip. */
export interface TestRow {
  nodeid: string;
  when: "setup" | "call" | "teardown";
  outcome: "passed" | "failed" | "skipped";
  seconds: number;
  message?: string;
}

export interface RunSelected {
  count: number;
  suite_tests: number;
  files: Impact["files"];
  note?: string;
  untested_seeds: Seed[];
  runtime_tests: number;
  tests: { id: string; name: string; file: string; line: number; p: number; hop: number | null; reach?: boolean }[];
}

export interface RunDone {
  mode: RunMode;
  selected?: number | null;
  suite_tests?: number;
  exit_code?: number;
  seconds: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  note?: string;
  output_tail?: string;
  culprits?: CulpritResult;
  /** coverage mode */
  edges?: number;
  symbols_covered?: number;
  tests_run?: number;
  /** the TestRun this run was recorded as (D25); absent for coverage mode */
  run_id?: string;
}

/** A recorded TestRun node (D25). `trigger` is "run" for a user run and "heal" for a re-run after an AI edit. */
export interface TestRunSummary {
  id: string;
  mode: string;
  trigger: "run" | "heal" | string;
  started: number;
  seconds: number;
  passed: number;
  failed: number;
  skipped: number;
  exit_code: number;
  tests: number;
  selected: number;
  commit: string;
  parent?: string | null;
  heal_step?: string;
  heal_round?: number;
  heal_suspect?: string;
  heal_diff?: string;
  heal_why?: string;
  /** ran under per-test coverage, so its culprit ranking uses executed code (D26) */
  measured?: boolean;
}

export interface RunDetail extends TestRunSummary {
  failures: { nodeid: string; test: string; when?: string; message: string }[];
  changed: string[];
  culprits: CulpritResult | null;
  output_tail: string;
  results: { test: string; outcome: "passed" | "failed" | "skipped"; seconds: number; message?: string }[];
  retries: string[];
  history?: Record<string, { runs: number; failed: number }>;
}

/** One fix attempt from the heal loop (analysis/heal.py HealRound). */
export interface HealRound {
  n: number;
  suspect: { id: string; name: string; file: string; line?: number; score?: number };
  file: string;
  before_failed: number;
  after_failed: number;
  outcome: "fixed" | "partial" | "no_change" | "worse" | "write_rejected" | "claude_error" | string;
  reverted: boolean;
  diff_preview?: string | null;
  /** the fixer's "Cause: … Evidence: …" */
  explanation?: string | null;
  /** the read-only graph lookups the fixer made before editing */
  tools?: { name: string; input: Record<string, unknown> }[] | null;
}

export interface HealDone {
  verdict: string;
  note: string;
  initial: { passed: number; failed: number } | null;
  final: { passed: number; failed: number } | null;
  rounds: Omit<HealRound, "n">[];
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError("network error: is the web server running?", 0);
  }
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* plain-text body (diff.md) */
  }
  if (!res.ok) throw new ApiError(detail(data) ?? `${res.status} ${res.statusText}`, res.status);
  return data as T;
}

/** FastAPI errors: `{detail: "..."}` or a list of pydantic issues. */
function detail(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || !("detail" in data)) return typeof data === "string" && data ? data : undefined;
  const d = (data as { detail: unknown }).detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((x) => `${(x.loc ?? []).slice(1).join(".")}: ${x.msg}`).join("; ");
  return undefined;
}

const r = (repo: string) => `/repos/${encodeURIComponent(repo)}`;
const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") s.set(k, String(v));
  return s.toString() ? `?${s}` : "";
};

export const api = {
  health: () => request<{ ok: boolean; version: string; falkordb: string }>("GET", "/health"),
  repos: () => request<{ repos: Repo[] }>("GET", "/repos"),
  index: (b: { path?: string; url?: string; name?: string; full?: boolean; history?: boolean }) =>
    request<{ repo: string; status: string; after: number }>("POST", "/repos", b),
  drop: (repo: string) => request<{ dropped: string }>("DELETE", r(repo)),
  overview: (repo: string) => request<Overview & { receipts: Receipts }>("GET", `${r(repo)}/overview`),
  search: (repo: string, query: string, limit = 20) =>
    request<{ symbols: SymbolBrief[]; files: { path: string; lang: string }[] }>("GET", `${r(repo)}/search${q({ q: query, limit })}`),
  symbol: (repo: string, ref: string) =>
    request<SymbolDetail | FileDetail | { candidates: SymbolBrief[] }>("GET", `${r(repo)}/symbol${q({ ref })}`),
  file: (repo: string, path: string) => request<FileDetail>("GET", `${r(repo)}/file${q({ path })}`),
  impact: (repo: string, b: { targets: string[]; change: Change; depth?: number }) => request<Impact>("POST", `${r(repo)}/impact`, b),
  diff: (repo: string, b: { rev?: string; depth?: number }) => request<DiffResult>("POST", `${r(repo)}/diff`, b),
  path: (repo: string, b: { source: string; target: string; depth?: number }) => request<PathResult>("POST", `${r(repo)}/path`, b),
  culprit: (repo: string, b: { failing: string[]; changed?: string[]; limit?: number }) =>
    request<CulpritResult>("POST", `${r(repo)}/culprit`, b),
  cypher: (repo: string, query: string) =>
    request<{ rows: Record<string, unknown>[]; count: number; receipts: Receipts }>("POST", `${r(repo)}/cypher`, { query }),
  runtime: () => request<{ enabled: boolean; reason: string | null }>("GET", "/runtime"),
  runs: (repo: string, limit = 20) => request<{ runs: TestRunSummary[] }>("GET", `${r(repo)}/runs${q({ limit })}`),
  runDetail: (repo: string, id: string) => request<RunDetail>("GET", `${r(repo)}/runs/${encodeURIComponent(id)}`),

  /* ---- test libraries ----------------------------------------------------- */

  libraries: (repo: string) => request<{ libraries: TestLibrary[] }>("GET", `${r(repo)}/libraries`),
  /** Register an external pytest directory. The repo must be re-indexed before its tests appear. */
  libraryAdd: (repo: string, name: string, path: string) =>
    request<LibraryResult>("POST", `${r(repo)}/libraries`, { name, path }),
  libraryRemove: (repo: string, name: string) =>
    request<LibraryResult>("DELETE", `${r(repo)}/libraries/${encodeURIComponent(name)}`),

  /* ---- built-in script library (D28) -------------------------------------- */

  /** The catalog for this repo. `can_exec` is the run gate: without it only check/graph scripts run. */
  scripts: (repo: string, p: { q?: string; category?: string; ecosystem?: string; applicable?: boolean } = {}) =>
    request<ScriptListing>("GET", `${r(repo)}/scripts${q({ ...p, applicable: p.applicable ? "true" : undefined })}`),

  /** Which tests a change selects — the same computation a run does, without executing anything. */
  selectTests: (repo: string, b: { targets?: string[]; rev?: string }) => request<RunSelected>("POST", `${r(repo)}/tests`, b),

  /* ---- analysis ----------------------------------------------------------- */

  owners: (repo: string, paths: string[]) => request<{ owners: Owner[]; cochange: Cochange[] }>("POST", `${r(repo)}/owners`, { paths }),
  hotspots: (repo: string, limit = 20) =>
    request<{ hotspots: Hotspot[]; central: Overview["central"] }>("GET", `${r(repo)}/hotspots${q({ limit })}`),
  /** Candidates, not verdicts — reflection and string dispatch are invisible to the graph. */
  deadCode: (repo: string, limit = 100) =>
    request<{ candidates: Overview["dead_code"]; note: string }>("GET", `${r(repo)}/dead-code${q({ limit })}`),
  graph: (repo: string, limit = 600) => request<FileGraph>("GET", `${r(repo)}/graph${q({ limit })}`),
  /** The diff report as Markdown, for copying into a PR. */
  diffMd: (repo: string, b: { rev?: string; depth?: number }) => request<string>("POST", `${r(repo)}/diff.md`, b),
  stats: () => request<{ queries: Record<string, unknown>; indexing: string[] }>("GET", "/stats"),

  ask: (repo: string, b: AskPayload) => request<AskResult>("POST", `${r(repo)}/ask`, b),

  /* ---- model providers (D27) ---------------------------------------------- */

  providers: () => request<{ providers: ProviderStatus[]; default: string | null }>("GET", "/providers"),
  /**
   * Store a key for a provider. Loopback-only on the server: a shared deployment must use the environment
   * variable instead. The key is written server-side at 0600 and is never returned by any route.
   */
  providerSetKey: (id: string, key: string) =>
    request<ProviderAck>("PUT", `/providers/${encodeURIComponent(id)}`, { key }),
  providerClearKey: (id: string) => request<ProviderAck>("DELETE", `/providers/${encodeURIComponent(id)}`),
};

export interface FileGraph {
  nodes: {
    path: string;
    lang: string;
    loc: number;
    is_test?: boolean;
    churn?: number;
    community?: number;
    error?: string;
    symbols: number;
    complexity: number;
  }[];
  edges: { src: string; dst: string }[];
}

export interface TestLibrary {
  name: string;
  path: string;
  /** false when the directory has been moved or deleted since it was registered */
  on_disk: boolean;
  files?: number;
  tests?: number;
}

export interface LibraryResult {
  repo: string;
  libraries: Record<string, string>;
  note?: string;
}

export type ScriptKind = "check" | "graph" | "command";
export type ScriptStatus = "passed" | "warned" | "failed" | "error" | "skipped";

export interface Script {
  id: string;
  name: string;
  category: string;
  ecosystem: string;
  summary: string;
  kind: ScriptKind;
  /** command scripts execute the repo's code or a tool, and sit behind the run gate */
  executes: boolean;
  tool: string | null;
  severity: "error" | "warn" | "info";
  tags: string[];
  /** the files it looks at exist in this repo */
  applies: boolean;
  /** its tool is installed; null when that can't be told without running anything */
  available: boolean | null;
}

export interface ScriptListing {
  scripts: Script[];
  total: number;
  applicable: number;
  categories: { id: string; label: string; applicable: number }[];
  files_scanned: number;
  can_exec: boolean;
  exec_reason: string | null;
}

export interface ScriptFinding {
  file: string;
  line: number | null;
  message: string;
}

export interface ScriptResult {
  id: string;
  name: string;
  category: string;
  kind: ScriptKind;
  status: ScriptStatus;
  count: number;
  findings: ScriptFinding[];
  seconds: number;
  reason?: string;
  exit_code?: number;
  command?: string;
  run_id?: string;
  summary?: Record<string, number>;
  output_tail?: string;
}

export const eventsUrl = (repo: string, after = 0) => `/api/v1${r(repo)}/events?after=${after}`;
export const askStreamUrl = (repo: string) => `/api/v1${r(repo)}/ask/stream`;
/** POST {@link RunRequest}; SSE frames: start, selected, test, progress, done, error, end (D18). */
export const runStreamUrl = (repo: string) => `/api/v1${r(repo)}/run/stream`;
/** POST {max_rounds?, timeout?}; SSE frames: start, run, ran, suspect, asking, round, done, error, end (D25). */
export const healStreamUrl = (repo: string, id: string) => `/api/v1${r(repo)}/runs/${encodeURIComponent(id)}/heal/stream`;
/** POST {ids, timeout?}; SSE frames: start, script, test, result, done, error, end (D28). */
export const scriptsStreamUrl = (repo: string) => `/api/v1${r(repo)}/scripts/run/stream`;
