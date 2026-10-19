"""Claude-driven fix loop on top of the runtime test-selection/execution layer (D15).

`aftershock run` selects the tests a change reaches, runs them for real, and ranks culprits on failure
(aftershock.runtime.pytest_run + aftershock.analysis.culprit). `heal` does the same select -> run -> rank step,
then goes one further: it asks Claude to rewrite the top suspect's whole file, re-runs the SAME selected tests for
real to check, and only keeps the edit if the failing set strictly shrank (D16) -- otherwise it reverts and tries
the next suspect. Bounded rounds, dry-run by default (`apply=False` never calls Claude or writes), whole-file
replacement rather than a diff Claude might apply wrong, and the suspect is never the failing test itself --
`culprit.suspects` already excludes tests and modules from its candidates -- so heal cannot "fix" a bug by rewriting
the test that caught it.

Kept out of the read-only MCP tool surface (D15): this is the one Aftershock operation that executes the target
repo's code and writes to its files, which a remote/automated caller should never be able to trigger unattended.
The API exposes it only behind the same gate as test runs (AFTERSHOCK_ALLOW_RUN plus a loopback client, D25).

Claude sees what the graph knows, not just the traceback (D25): the culprit's call chain from the failing test to
the suspect, and the source of each hop, the localization context Agentless and AutoCodeRover give their repair step.
Every run heal makes is recorded as a TestRun (runtime/runs.py) linked RETRY_OF to the one before it.

The fixer is an agent over the graph, not a one-shot prompt (D26): it gets Aftershock's read-only MCP tools
(`symbol`, `explain_path`, `impact`, `run_detail`, `cypher`, ...) and may follow callers, other tests and the run's
history before it edits, and it must state the cause and the evidence it relied on. Both, and the tools it called,
are kept on the round, so a fix explains itself. Its tool server is started with running switched off, so the
fixer can read the graph but never run or heal anything itself.
"""

from __future__ import annotations

import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .. import tools as T
from ..graph import RepoGraph
from ..ingest.discover import library_sources
from ..runtime.pytest_run import Outcome, node_to_symbol, run_measured, run_selected

MAX_ROUNDS_DEFAULT = 3
CLAUDE_TIMEOUT_S = 120
FIX_MODEL = "claude-opus-5"
MAX_SUSPECT_FILE_CHARS = 20_000
MAX_REGION_LINES = 400
MAX_CONTEXT_HOPS = 4  # source of at most this many symbols along the chain goes into the prompt
MAX_CONTEXT_LINES = 60  # per symbol
CLI_BACKEND = "claude-cli"  # passed in place of an API key: propose fixes through the local `claude` CLI
PROVIDER_BACKEND = "provider"  # passed in place of an API key: propose fixes through a configured provider (D29)
MAX_TOOL_CALLS = 6  # graph lookups the fixer may make before it must answer
GRAPH_TOOLS = ("search", "symbol", "explain_path", "impact", "select_tests", "culprit", "run_detail", "test_runs",
               "owners", "cypher")  # read-only; never run_tests/heal


@dataclass
class HealRound:
    suspect: dict
    file: str
    before_failed: int
    after_failed: int
    outcome: str  # "fixed" | "partial" | "no_change" | "worse" | "write_rejected" | "claude_error"
    reverted: bool
    diff_preview: str | None = None
    explanation: str | None = None  # the fixer's "Cause: ... Evidence: ..." (D26)
    tools: list[dict] | None = None  # the graph lookups it made: [{name, input}]

    def as_dict(self) -> dict:
        return {k: getattr(self, k) for k in self.__dataclass_fields__}


@dataclass
class HealReport:
    repo: str
    initial: dict | None = None
    rounds: list[HealRound] = field(default_factory=list)
    final: dict | None = None
    verdict: str = "not_run"
    note: str = ""
    widened: int = 0  # tests run beyond the selection because the selection was all green

    def as_dict(self) -> dict:
        return {"repo": self.repo, "initial": self.initial, "rounds": [r.as_dict() for r in self.rounds],
                "final": self.final, "verdict": self.verdict, "note": self.note,
                "widened": self.widened}


def _summarize(out: Outcome) -> dict:
    by = out.by_outcome()
    failed = out.failed
    return {"ok": not failed and out.exit_code in (0, 5), "passed": len(by.get("passed", [])),
            "failed": len(failed), "skipped": len(by.get("skipped", [])), "seconds": out.seconds,
            "exit_code": out.exit_code, "failing": [r["nodeid"] for r in failed], "tail": out.stdout_tail}


FIX_SYSTEM = (
    "You are fixing a failing test in a real codebase. You will be given the failing test output, a function the "
    "fault-localization ranked as the most likely culprit, the call chain the code graph found from the failing test "
    "to it with the source of each step, and the current contents of the file that defines it.\n\n"
    "You may call the Aftershock code-graph tools (read-only) when the given context is not enough: `symbol` for a "
    "function's callers and callees, `explain_path` for how two symbols connect, `impact` for what else depends on "
    "the code you would change, `run_detail` for the recorded run (each failing test's history, the other suspects), "
    f"`cypher` for anything else. At most {MAX_TOOL_CALLS} calls; skip them when the bug is plain.\n\n"
    "Then answer in exactly this shape:\n"
    "Cause: <one sentence: what is wrong and why the failing test sees it>\n"
    "Evidence: <one or two sentences: the code lines and graph facts (callers, chain, history) that show it>\n"
    "followed by the corrected code in a single fenced code block, nothing after the fence. Make the smallest change "
    "that makes the failure go away; preserve unrelated code, formatting, comments, and behavior exactly, and do not "
    "change what a test expects. If you cannot determine a fix, say so in one sentence instead of guessing, and do "
    "not include a code fence."
)


def _explanation(text: str) -> str:
    """The fixer's reasoning: everything before the code fence (Cause / Evidence), trimmed."""
    return text.split("```", 1)[0].strip()[:1500]


def _extract_code_block(text: str) -> str | None:
    m = re.search(r"```(?:[a-zA-Z0-9_+-]*)\n(.*?)```", text, re.DOTALL)
    return m.group(1) if m else None


def cli_backend() -> str | None:
    """`CLI_BACKEND` when the Claude Code CLI is on PATH, so heal works where only a logged-in CLI exists."""
    return CLI_BACKEND if shutil.which("claude") else None


def provider_backend() -> tuple[str, str] | None:
    """(`PROVIDER_BACKEND`, model id) when a provider key is configured (Settings or e.g. OPENROUTER_API_KEY), so heal
    works on a server with neither ANTHROPIC_API_KEY nor the claude CLI. The model id is `providers`' default."""
    from .. import providers

    mid = providers.default_model()
    return (PROVIDER_BACKEND, mid) if mid and providers.resolve(mid) else None


def _ask_provider(model_id: str, prompt: str) -> tuple[str | None, str]:
    # one shot, no graph tools: the prompt already carries the culprit chain and the source along it
    from .. import providers
    from ..agent_openai import ProviderError, _post

    picked = providers.resolve(model_id)
    if picked is None:
        return None, f"model {model_id!r} has no configured provider"
    provider, model = picked
    key = providers.key_for(provider.id)
    if provider.wire == "anthropic":
        return _ask_api(key or "", model, prompt, None, [])
    body = {"model": model, "messages": [{"role": "system", "content": FIX_SYSTEM},
                                         {"role": "user", "content": prompt}], provider.max_tokens_field: 8000}
    try:
        out = _post(provider, key, body)
    except ProviderError as e:
        return None, f"{provider.label} request failed: {e}"
    return ((out.get("choices") or [{}])[0].get("message") or {}).get("content") or "", ""


def _graph_env() -> dict[str, str]:
    # the fixer's tool server may read the graph, never run tests or heal (it would be heal calling heal)
    return {k: v for k, v in os.environ.items() if k != "CLAUDECODE"} | {"AFTERSHOCK_ALLOW_RUN": "0"}


def _ask_cli(model: str, prompt: str, tools: list[dict]) -> tuple[str | None, str]:
    # print mode, no built-in tools (it cannot read or edit files), only Aftershock's read-only graph tools over a
    # stdio MCP server of its own, run outside the repo
    env = _graph_env()
    mcp = {"mcpServers": {"aftershock": {"command": sys.executable, "args": ["-m", "aftershock.mcp_server"],
                                         "env": {"AFTERSHOCK_ALLOW_RUN": "0"}}}}
    cmd = ["claude", "-p", "--model", model, "--tools", "", "--strict-mcp-config", "--mcp-config", json.dumps(mcp),
           "--allowedTools", *(f"mcp__aftershock__{t}" for t in GRAPH_TOOLS), "--no-session-persistence",
           "--output-format", "stream-json", "--verbose", "--system-prompt", FIX_SYSTEM]
    with tempfile.TemporaryDirectory(prefix="aftershock-heal-") as cwd:
        try:
            p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, cwd=cwd, env=env,
                               timeout=CLAUDE_TIMEOUT_S * 4)
        except (OSError, subprocess.TimeoutExpired) as e:
            return None, f"claude CLI failed: {e}"
    if p.returncode != 0:
        return None, f"claude CLI exited {p.returncode}: {(p.stderr or p.stdout).strip()[:300]}"
    result = None
    for line in p.stdout.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "assistant":
            for b in (ev.get("message") or {}).get("content") or []:
                if b.get("type") == "tool_use":
                    tools.append({"name": b.get("name", "").removeprefix("mcp__aftershock__"),
                                  "input": b.get("input")})
        elif ev.get("type") == "result":
            if ev.get("is_error"):
                return None, f"claude CLI: {str(ev.get('result') or ev.get('subtype'))[:300]}"
            result = ev.get("result") or ""
    return (result, "") if result is not None else (None, "claude CLI returned no result")


def _ask_api(api_key: str, model: str, prompt: str, repo: str | None, tools: list[dict]) -> tuple[str | None, str]:
    import anthropic

    from .. import agent

    client = anthropic.Anthropic(api_key=api_key)
    specs = [t for t in agent.tool_specs() if t["name"] in GRAPH_TOOLS] if repo else []
    messages: list[dict] = [{"role": "user", "content": prompt}]
    for _ in range(MAX_TOOL_CALLS + 1):
        try:
            resp = client.messages.create(model=model, max_tokens=8000, system=FIX_SYSTEM, messages=messages,
                                          timeout=CLAUDE_TIMEOUT_S, **({"tools": specs} if specs else {}))
        except anthropic.APIError as e:  # rate limit, timeout, bad request, etc: never let it crash the heal loop
            return None, f"Claude request failed: {e}"
        uses = [b for b in resp.content if getattr(b, "type", "") == "tool_use"]
        if resp.stop_reason != "tool_use" or not uses or len(tools) >= MAX_TOOL_CALLS:
            return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text"), ""
        messages.append({"role": "assistant", "content": resp.content})
        results = []
        for b in uses:
            tools.append({"name": b.name, "input": b.input})
            try:
                content, err = json.dumps(agent.call_tool(repo, b.name, dict(b.input)), default=str)[:30_000], False
            except Exception as e:  # noqa: BLE001 -- a bad lookup is the model's to recover from
                content, err = f"Error: {e}", True
            results.append({"type": "tool_result", "tool_use_id": b.id, "content": content, "is_error": err})
        messages.append({"role": "user", "content": results})
    return None, "the fixer kept calling tools without answering"


def _propose_fix(api_key: str, model: str, test_output: str, suspect: dict, file_text: str) -> tuple[str | None, str]:
    """`file_text` is the whole file, or with `suspect["region"]` set, just those lines (the suspect's definition).
    The graph lookups the fixer makes are appended to `suspect["tools"]` when the caller passes a list there."""
    region = suspect.get("region")
    what = (f"Lines {region[0]}-{region[1]} of {suspect['file']} (the definition of `{suspect['name']}`; the rest "
            f"of the file is too large to send and stays as it is)" if region else f"Current contents of {suspect['file']}")
    ask = ("Return the corrected replacement for exactly these lines, same indentation, in a single fenced code block."
           if region else "Return the complete, corrected file contents in a single fenced code block.")
    ctx = suspect.get("context")
    repo, run_id = suspect.get("repo"), suspect.get("run_id")
    prompt = (
        (f"Repository (pass as `repo` to the graph tools): {repo}\n"
         + (f"Recorded run of this failure: {run_id}\n" if run_id else "") + "\n" if repo else "")
        + f"Failing test output:\n```\n{test_output[-4000:]}\n```\n\n"
        f"Suspect (fault-localization rank 1): `{suspect['name']}` in {suspect['file']} "
        f"around line {suspect.get('line')}"
        + (f" (id `{suspect['id']}`); {suspect['why']}" if suspect.get("why") else "") + ".\n\n"
        + (f"{ctx}\n\n" if ctx else "")
        + f"{what}:\n```\n{file_text}\n```\n\n{ask}"
    )
    used = suspect["tools"] if isinstance(suspect.get("tools"), list) else []
    text, err = (_ask_cli(model, prompt, used) if api_key == CLI_BACKEND
                 else _ask_provider(model, prompt) if api_key == PROVIDER_BACKEND
                 else _ask_api(api_key, model, prompt, repo, used))
    if text is None:
        return None, err
    code = _extract_code_block(text)
    if code is None:
        return None, text.strip() or "Claude returned no fenced code block"
    return code, text.strip()


def _diff(before: str, after: str, path: str, limit: int = 2000) -> str:
    d = "".join(difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True),
                                     f"a/{path}", f"b/{path}", n=2))
    return d if len(d) <= limit else d[:limit] + "\n… (diff truncated)\n"


def _region(suspect: dict, lines: list[str]) -> tuple[int, int] | None:
    """1-based inclusive line span of the suspect's definition, if it is known and small enough to send alone."""
    start, end = suspect.get("line"), suspect.get("end_line")
    if not start or not end or end < start or end > len(lines) or end - start + 1 > MAX_REGION_LINES:
        return None
    return start, end


def _push(rep: HealReport, say: Callable[[str, dict], None], r: HealRound) -> None:
    rep.rounds.append(r)
    say("round", {"n": len(rep.rounds), **r.as_dict()})


def _name(sid: str) -> str:
    return sid.split("::", 1)[-1]


def graph_context(g, root: Path, suspect: dict, libs: dict[str, str] | None = None) -> str:
    """The culprit's evidence as prompt text: the hop-by-hop chain from a failing test to the suspect (edge type,
    resolution and call lines), then the source of the test and of the symbols in between. Read from the graph's
    spans and the files on disk; a graph without spans (or a stub) still yields the chain."""
    path = suspect.get("path") or []
    if not path:
        return ""
    lines = ["How the failing test reaches the suspect (code graph, hop by hop):"]
    for e in path:
        at = f" at line {', '.join(map(str, e['lines'][:3]))}" if e.get("lines") else ""
        lines.append(f"  {_name(e['from'])} -[{e.get('type', 'CALLS')} {e.get('how', '')}]-> {_name(e['to'])}{at}")
    ids = [path[0]["from"], *(e["to"] for e in path[:-1])][:MAX_CONTEXT_HOPS]
    try:
        spans = {r["symbol"]["id"]: r["symbol"] for r in g.ro("symbols_by_ids", {"ids": ids})}
    except Exception:  # noqa: BLE001 -- context is a bonus; the fix loop must not fail over it
        spans = {}
    lib_files = library_sources(libs or {})
    for sid in ids:
        sym = spans.get(sid)
        if not sym or not sym.get("line"):
            continue
        f = lib_files.get(sym["file"]) or root / sym["file"]
        try:
            src = f.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        a, b = sym["line"], min(sym.get("end_line") or sym["line"], sym["line"] + MAX_CONTEXT_LINES - 1)
        lines += ["", f"{_name(sid)} ({sym['file']}:{a}):", "```", *src[a - 1 : b], "```"]
    return "\n".join(lines)


def heal(g: RepoGraph, root: Path, python: str, test_ids: list[str], changed_refs: list[str] | None, apply: bool,
         anthropic_api_key: str | None, max_rounds: int = MAX_ROUNDS_DEFAULT, timeout: int = 1800,
         widen: Callable[[], list[str]] | None = None, *, libs: dict[str, str] | None = None,
         emit: Callable[[str, dict], None] | None = None,
         recorder: Callable[[Outcome, dict], str | None] | None = None, measure: bool = False,
         model: str = FIX_MODEL, keep: bool = True) -> HealReport:
    """Select->run is the caller's job (test_ids already resolved, as `aftershock run` does it); this runs them,
    and if `apply` and a key are given, tries up to `max_rounds` Claude-proposed, re-verified fixes. `widen` returns
    tests that reach the change by a longer path; they run only when the selected ones are all green.

    `emit(event, data)` reports progress (run, suspect, asking, round); `recorder(outcome, info)` persists each run
    (see runtime/runs.py) and returns its id, which the next run's info carries as `parent`. With `measure`, the
    first run is under per-test coverage, so the ranking uses what each test executed (D26). `keep=False` still
    verifies every edit but restores each file it wrote once the loop ends (a public showcase stays reproducible)."""
    rep = HealReport(repo=g.name)
    say = emit or (lambda event, data: None)
    last_run: list[str | None] = [None]

    def run(ids: list[str], **info) -> Outcome:
        say("run", {"tests": len(ids), **info})
        if measure and info.get("step") == "initial":  # later runs follow edits the graph's spans don't know
            o, cov = run_measured(g, root, python, ids, timeout, libs=libs)
            info = {**info, "measured": cov is not None}
        else:
            o = run_selected(root, python, ids, timeout=timeout, libs=libs)
        if recorder is not None:
            last_run[0] = recorder(o, {**info, "parent": last_run[0]}) or last_run[0]
        sm = _summarize(o)
        say("ran", {"run_id": last_run[0], **sm, "failing": sm["failing"][:50], "tail": None,
                    **{k: v for k, v in info.items() if k != "diff"}})
        return o

    if not test_ids:
        rep.verdict, rep.note = "no_tests", "no tests were selected for this change"
        return rep
    out = run(test_ids, step="initial")
    rep.initial = _summarize(out)
    if not rep.initial["failed"] and not rep.initial["passed"]:  # nothing ran is not "green"
        rep.verdict = "no_tests"
        rep.note = f"pytest ran no tests (exit code {out.exit_code}): {out.stdout_tail.strip()[-300:]}"
        rep.final = rep.initial
        return rep
    if not rep.initial["failed"] and widen is not None:  # green at the usual depth: look further before saying so
        have = set(test_ids)
        extra = [i for i in widen() if i not in have]
        if extra:
            more = run(extra, step="widen")
            rep.widened = len(extra)
            if more.failed:  # the failures came from the wider set, so every re-run must include it
                test_ids = [*test_ids, *extra]
                out = Outcome(more.exit_code, out.seconds + more.seconds, out.results + more.results, more.stdout_tail)
            else:
                out = Outcome(out.exit_code, out.seconds + more.seconds, out.results + more.results, out.stdout_tail)
            rep.initial = _summarize(out)
    if not rep.initial["failed"]:
        rep.verdict = "all_passed"
        rep.note = f"{rep.initial['passed']} test(s) ran, all green"
        rep.final = rep.initial
        return rep
    if not apply:
        rep.verdict = "unresolved"
        rep.note = "would need --apply (and ANTHROPIC_API_KEY or the claude CLI) to attempt a fix"
        rep.final = rep.initial
        return rep
    if not anthropic_api_key:
        rep.verdict = "unresolved"
        rep.note = "ANTHROPIC_API_KEY is not set and the claude CLI was not found; cannot propose a fix"
        rep.final = rep.initial
        return rep

    touched: dict[Path, str] = {}  # file -> its text before the first edit, for keep=False
    try:
        current_failing = set(rep.initial["failing"])
        last_tail = rep.initial["tail"]
        seen_files: set[str] = set()  # only added on write_rejected/claude_error/revert, never on a kept partial fix
        for _round in range(max_rounds):
            failing_refs = sorted({node_to_symbol(n) for n in current_failing})  # recomputed each round: a test that
            suspects = T.culprits(g.name, failing_refs, changed_refs, limit=10)  # got fixed must stop pointing at it
            candidates = [s for s in suspects.get("suspects", []) if s["file"] not in seen_files]
            if not candidates:
                rep.note = "no further (unexplored) suspects; stopping"
                break
            suspect = candidates[0]
            say("suspect", {k: suspect.get(k) for k in ("id", "name", "file", "line", "score", "hops", "path")})
            fpath = root / suspect["file"]
            if not fpath.is_file():
                seen_files.add(suspect["file"])
                _push(rep, say, HealRound(suspect, suspect["file"], len(current_failing), len(current_failing),
                                            "write_rejected", False, "suspect file not found on disk"))
                continue
            original = fpath.read_text(encoding="utf-8", errors="replace")
            lines = original.splitlines(keepends=True)
            span = _region(suspect, lines) if len(original) > MAX_SUSPECT_FILE_CHARS else None
            if len(original) > MAX_SUSPECT_FILE_CHARS and span is None:
                seen_files.add(suspect["file"])
                _push(rep, say, HealRound(suspect, suspect["file"], len(current_failing), len(current_failing),
                                            "write_rejected", False,
                                            f"file too large ({len(original)} chars) to send whole, and the suspect's "
                                            "own span is unknown or too long"))
                continue
            ctx = graph_context(g, root, suspect, libs)
            say("asking", {"model": model, "suspect": suspect["name"], "file": suspect["file"],
                           "context_chars": len(ctx)})
            used: list[dict] = []
            suspect = {**suspect, "repo": g.name, "run_id": last_run[0], "tools": used}
            if span:  # large file: send and replace only the suspect's definition
                body = "".join(lines[span[0] - 1 : span[1]])
                new_body, explanation = _propose_fix(anthropic_api_key, model, last_tail,
                                                     {**suspect, "region": list(span), "context": ctx}, body)
                new_text = None if new_body is None else "".join(
                    [*lines[: span[0] - 1], new_body.rstrip("\n") + "\n", *lines[span[1]:]])
            else:
                new_text, explanation = _propose_fix(anthropic_api_key, model, last_tail, {**suspect, "context": ctx},
                                                     original)
            why = _explanation(explanation) or None
            suspect = {k: v for k, v in suspect.items() if k not in ("repo", "run_id", "tools")}
            if new_text is None or new_text == original:
                seen_files.add(suspect["file"])
                _push(rep, say, HealRound(suspect, suspect["file"], len(current_failing), len(current_failing),
                                            "claude_error", False, explanation[:300], None, used or None))
                continue
            touched.setdefault(fpath, original)
            fpath.write_text(new_text, encoding="utf-8")
            after = run(test_ids, step="verify", round=len(rep.rounds) + 1, suspect=suspect["id"],
                        diff=_diff(original, new_text, suspect["file"]), why=why or "")
            after_sum = _summarize(after)
            after_failing = set(after_sum["failing"])
            diff_preview = _diff(original, new_text, suspect["file"])
            if not after_failing:
                _push(rep, say, HealRound(suspect, suspect["file"], len(current_failing), 0, "fixed", False,
                                            diff_preview, why, used or None))
                rep.final = after_sum
                rep.verdict = "fixed"
                break
            progress = bool(after_failing) and after_failing < current_failing  # strict subset only
            if not progress:
                fpath.write_text(original, encoding="utf-8")
                seen_files.add(suspect["file"])
                outcome = "worse" if len(after_failing) > len(current_failing) else "no_change"
                _push(rep, say, HealRound(suspect, suspect["file"], len(current_failing), len(after_failing), outcome,
                                            True, diff_preview, why, used or None))
                continue
            _push(rep, say, HealRound(suspect, suspect["file"], len(current_failing), len(after_failing), "partial",
                                        False, diff_preview, why, used or None))
            current_failing = after_failing
            last_tail = after_sum["tail"]
            rep.final = after_sum
    finally:
        if not keep:
            for f, text in touched.items():
                f.write_text(text, encoding="utf-8")
    if rep.verdict != "fixed":
        rep.verdict = "unresolved"
        rep.note = rep.note or f"gave up after {len(rep.rounds)} round(s); every edit that didn't fully pass was reverted"
        rep.final = rep.final or rep.initial
    if touched and not keep:
        rep.note = (rep.note + "; " if rep.note else "") + "the checkout was restored afterwards (showcase)"
    return rep
