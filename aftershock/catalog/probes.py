"""Probe scripts (D29): tests about the test suite and the package, written for Aftershock rather than wrapping a
third-party tool. Each one drives the repo's own interpreter, through `execute` (same sandboxing as any command).

- py.import-smoke   import every module of the repo's packages: import-time errors without a single test
- py.cli-smoke      every declared console script resolves and answers --help
- pytest.flaky      the suite three times (forward, reversed, forward): tests whose outcome changes
- pytest.isolation  each test file on its own vs in the full suite: tests that lean on another file's side effects
- ai.unit-tests     a model writes pytest tests for the central code no test reaches; only passing files are kept
"""

from __future__ import annotations

import json
import re
import tempfile
import time
from pathlib import Path

from .. import tools as T
from . import MAX_FINDINGS, OUTPUT_TAIL, Ctx, Finding, Script, _findings_from, execute, register
from .commands import _py, _pytests

RUNTIME = Path(__file__).resolve().parent.parent / "runtime"
SMOKE = RUNTIME / "_aftershock_smoke.py"
MAX_ISOLATION_FILES = 40
AI_TARGETS = 3
AI_ATTEMPTS = 2
GENERATED_DIR = "tests/aftershock_generated"


def probe(id_, name, cat, summary, runner, applies, *, tool=None, severity="error", timeout=900, tags=(),
          local_only=False):
    return Script(id=id_, name=name, category=cat, ecosystem="python", summary=summary, kind="command",
                  runner=runner, tool=tool, applies=applies, severity=severity, timeout=timeout, tags=tuple(tags),
                  local_only=local_only)


def _result(status: str, found: list[Finding], output: str, *, summary: dict | None = None,
            reason: str | None = None, command: str = "") -> dict:
    res = {"status": status, "findings": [f.as_dict() for f in found[:MAX_FINDINGS]], "count": len(found),
           "output_tail": output[-OUTPUT_TAIL:], "command": command}
    if summary:
        res["summary"] = summary
    if reason:
        res["reason"] = reason
    return res


# ---- smoke ---------------------------------------------------------------------------------------------------------


def _smoke(mode: str):
    def run(ctx: Ctx, *, emit=None, cancel=None, timeout=900) -> dict:
        rc, out, why = execute([ctx.python, str(SMOKE), mode, str(ctx.root)], ctx, cancel=cancel, timeout=timeout)
        found = _findings_from(out, ctx)
        status = "error" if why else ("passed" if rc == 0 else "failed")
        return _result(status, found, out, reason=why, command=f"python -m aftershock-smoke {mode}")
    return run


def _packages(c: Ctx) -> bool:
    return any(re.fullmatch(r"(src/)?[A-Za-z_][\w]*/__init__\.py", f) for f in c.files)


def _console_scripts(c: Ctx) -> bool:
    return ("[project.scripts]" in (c.text("pyproject.toml") or "")
            or "console_scripts" in (c.text("setup.cfg") or ""))


# ---- pytest passes -------------------------------------------------------------------------------------------------


def _pass(ctx: Ctx, args: list[str], *, cancel, deadline: float, reverse: bool = False
          ) -> tuple[dict[str, str], dict[str, str], str, str | None]:
    """One pytest run through Aftershock's plugin. Returns ({nodeid: outcome}, {nodeid: message}, output, why)."""
    with tempfile.TemporaryDirectory(prefix="aftershock-probe-") as tmp:
        results = Path(tmp) / "results.jsonl"
        env = {"AFTERSHOCK_RESULTS": str(results), "PYTHONPATH": str(RUNTIME)}
        if reverse:
            env["AFTERSHOCK_REVERSE"] = "1"
        argv = [ctx.python, "-m", "pytest", "-q", "-p", "no:cacheprovider", "-p", "_aftershock_pytest", *args]
        rc, out, why = execute(argv, ctx, cancel=cancel, timeout=max(1.0, deadline - time.monotonic()), env=env)
        outcomes: dict[str, str] = {}
        messages: dict[str, str] = {}
        if results.exists():
            for line in results.read_text().splitlines():
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                node = r["nodeid"]
                if r["outcome"] == "failed":
                    outcomes[node] = "failed"
                    tail = (r.get("message") or "").strip().splitlines()
                    messages.setdefault(node, tail[-1][:200] if tail else "")
                elif outcomes.get(node) != "failed":
                    outcomes[node] = r["outcome"]
    if rc not in (0, 1, 5) and not why:
        why = f"pytest exited {rc}"
    return outcomes, messages, out, why


def _locate(ctx: Ctx, node: str) -> tuple[str, int | None]:
    file = node.split("::", 1)[0]
    name = node.split("::")[-1].split("[", 1)[0]
    for n, line in ctx.lines(file):
        if re.match(rf"\s*(async\s+)?def {re.escape(name)}\b", line):
            return file, n
    return file, None


def flaky(ctx: Ctx, *, emit=None, cancel=None, timeout=900) -> dict:
    deadline = time.monotonic() + timeout
    plan = [("forward", False), ("reversed", True), ("forward again", False)]
    runs: list[tuple[str, dict[str, str]]] = []
    logs = []
    for label, rev in plan:
        outcomes, _, out, why = _pass(ctx, [], cancel=cancel, deadline=deadline, reverse=rev)
        logs.append(f"== pass {len(runs) + 1}: {label}: {sum(v == 'failed' for v in outcomes.values())} failed "
                    f"of {len(outcomes)}\n{out[-1500:]}")
        if why:
            return _result("error", [], "\n".join(logs), reason=f"pass {len(runs) + 1} ({label}): {why}")
        runs.append((label, outcomes))
    nodes = sorted(set().union(*(o.keys() for _, o in runs)))
    found, always = [], 0
    for node in nodes:
        seq = [o.get(node, "not run") for _, o in runs]
        if all(s == "failed" for s in seq):
            always += 1
            continue
        if "failed" in seq and len(set(seq) - {"skipped"}) > 1:
            only_rev = seq[1] == "failed" and seq[0] != "failed" and seq[2] != "failed"
            kind = "order-dependent (fails only when the suite runs in reverse)" if only_rev else "flaky"
            file, line = _locate(ctx, node)
            found.append(Finding(file, line, f"{node}: {kind}; outcomes " + ", ".join(
                f"{s} ({label})" for s, (label, _) in zip(seq, runs, strict=True))))
    return _result("failed" if found else "passed", found, "\n".join(logs),
                   summary={"tests": len(nodes), "passes": len(runs), "unstable": len(found),
                            "always_failing": always},
                   command="pytest ×3 (forward, reversed, forward)")


def isolation(ctx: Ctx, *, emit=None, cancel=None, timeout=900) -> dict:
    deadline = time.monotonic() + timeout
    suite, msgs, out, why = _pass(ctx, [], cancel=cancel, deadline=deadline)
    if why:
        return _result("error", [], out, reason=f"full suite: {why}")
    files = sorted({n.split("::", 1)[0] for n in suite})
    logs = [f"== full suite: {sum(v == 'failed' for v in suite.values())} failed of {len(suite)}"]
    if len(files) > MAX_ISOLATION_FILES:
        logs.append(f"only the first {MAX_ISOLATION_FILES} of {len(files)} test files are run alone")
    found = []
    ran = 0
    for f in files[:MAX_ISOLATION_FILES]:
        if cancel is not None and cancel.is_set() or time.monotonic() >= deadline:
            logs.append(f"stopped after {ran} files: {'stopped' if cancel and cancel.is_set() else 'out of time'}")
            break
        alone, amsg, aout, awhy = _pass(ctx, [f], cancel=cancel, deadline=deadline)
        ran += 1
        if awhy and not alone:
            found.append(Finding(f, 1, f"cannot run on its own: {awhy}; {aout.strip().splitlines()[-1:] or ''}"))
            continue
        for node, outcome in alone.items():
            before = suite.get(node)
            if outcome == "failed" and before == "passed":
                file, line = _locate(ctx, node)
                found.append(Finding(file, line, f"{node}: fails when its file runs alone, passes in the full suite "
                                                 f"(needs state another file sets up): {amsg.get(node, '')}"))
            elif outcome == "passed" and before == "failed":
                file, line = _locate(ctx, node)
                found.append(Finding(file, line, f"{node}: passes alone, fails in the full suite (another test "
                                                 f"leaves state behind): {msgs.get(node, '')}"))
    logs.append(f"{ran} files run alone")
    return _result("failed" if found else "passed", found, "\n".join(logs),
                   summary={"tests": len(suite), "files": len(files), "files_run": ran, "dependent": len(found)},
                   command="pytest per test file vs the full suite")


# ---- model-written tests ---------------------------------------------------------------------------------------------

_SYSTEM = (
    "You write pytest unit tests for existing Python code. Test the behaviour the code has now, through its public "
    "interface, with small deterministic inputs. No network, no sleeping, no writes outside pytest's tmp_path, no "
    "new dependencies beyond pytest and the package itself. Prefer several focused tests over one large one. "
    "Return one complete test module in a single ```python fenced block and nothing else."
)
_SYMBOL = """
    MATCH (s:Symbol {id: $id}) RETURN s.id AS id, s.qname AS qname, s.name AS name, s.file AS file, s.line AS line,
    s.end_line AS end_line, s.signature AS signature, s.kind AS kind"""


def _complete(prompt: str) -> str:
    """One model turn, through whichever provider has a key (D27). Raises ToolError when none does."""
    from .. import providers

    picked = providers.resolve(providers.default_model())
    if picked is None:
        raise T.ToolError("no model is configured: add a provider key (Settings) or ANTHROPIC_API_KEY")
    provider, model = picked
    key = providers.key_for(provider.id)
    if provider.wire == "anthropic":
        import anthropic

        resp = anthropic.Anthropic(api_key=key).messages.create(
            model=model, max_tokens=6000, system=_SYSTEM, messages=[{"role": "user", "content": prompt}],
            timeout=180)
        return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
    from ..agent_openai import _post

    body = {"model": model, "messages": [{"role": "system", "content": _SYSTEM},
                                         {"role": "user", "content": prompt}], provider.max_tokens_field: 6000}
    out = _post(provider, key, body)
    return ((out.get("choices") or [{}])[0].get("message") or {}).get("content") or ""


def _module_of(file: str) -> str:
    parts = Path(file).with_suffix("").parts
    if parts and parts[0] == "src":
        parts = parts[1:]
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _code(text: str) -> str | None:
    m = re.search(r"```(?:python|py)?\n(.*?)```", text, re.DOTALL)
    return m.group(1).strip() + "\n" if m else None


def _targets(ctx: Ctx) -> list[dict]:
    from .graph_checks import untested_hubs

    out = []
    for f in untested_hubs(ctx):
        if not f.file.endswith(".py") or "/" + f.file.split("/")[-1] == "/__main__.py":
            continue
        sid = f.message.split(" is central", 1)[0]
        rows = ctx.graph.ro("catalog_symbol", {"id": sid}, query=_SYMBOL)
        if rows and rows[0].get("end_line"):
            out.append(rows[0])
        if len(out) >= AI_TARGETS:
            break
    return out


def ai_unit_tests(ctx: Ctx, *, emit=None, cancel=None, timeout=900) -> dict:
    deadline = time.monotonic() + timeout
    targets = _targets(ctx)
    if not targets:
        return _result("passed", [], "every central function is already reached by a test",
                       summary={"targets": 0, "kept": 0})
    keep_dir = ctx.root / GENERATED_DIR
    logs, found, kept = [], [], []
    for t in targets:
        if cancel is not None and cancel.is_set() or time.monotonic() >= deadline:
            logs.append("stopped before every target was tried")
            break
        lines = (ctx.text(t["file"]) or "").splitlines()
        src = "\n".join(lines[t["line"] - 1: t["end_line"]])
        head = "\n".join(lines[:60])
        mod = _module_of(t["file"])
        prompt = (f"Module `{mod}` (file {t['file']}). Write pytest tests for `{t['qname']}`.\n\n"
                  f"Top of the module (imports and context):\n```python\n{head}\n```\n\n"
                  f"The {t['kind']} under test (lines {t['line']}-{t['end_line']}):\n```python\n{src}\n```\n\n"
                  f"Import it as `from {mod.rsplit('.', 1)[0] if '.' in mod else mod} import ...` or `import {mod}`.")
        safe = re.sub(r"\W+", "_", t["qname"]).strip("_").lower()[:60]
        name = f"test_aftershock_{safe}.py"
        attempt_prompt, ok, last = prompt, False, ""
        for attempt in range(1, AI_ATTEMPTS + 1):
            try:
                code = _code(_complete(attempt_prompt))
            except T.ToolError as e:
                return _result("skipped", [], "\n".join(logs), reason=str(e))
            except Exception as e:  # noqa: BLE001 -- a provider error ends this script, not the batch
                return _result("error", [], "\n".join(logs), reason=f"model call failed: {type(e).__name__}")
            if not code:
                last = "the model returned no code block"
                continue
            # the candidate sits where it would be kept, so the repo's conftest and rootdir apply to it
            keep_dir.mkdir(parents=True, exist_ok=True)
            cand = keep_dir / f"_candidate_{name}"
            cand.write_text(code)
            try:
                outcomes, _, out, why = _pass(ctx, [cand.relative_to(ctx.root).as_posix()], cancel=cancel,
                                              deadline=deadline)
            finally:
                cand.unlink(missing_ok=True)
            passed = sum(v == "passed" for v in outcomes.values())
            failed = sum(v == "failed" for v in outcomes.values())
            logs.append(f"== {t['qname']} attempt {attempt}: {passed} passed, {failed} failed"
                        + (f" ({why})" if why else ""))
            if passed and not failed and not why:
                (keep_dir / name).write_text(f"# Written by Aftershock's ai.unit-tests for {t['qname']}; "
                                             f"kept because it passed. Review before relying on it.\n" + code)
                kept.append(f"{GENERATED_DIR}/{name}")
                found.append(Finding(f"{GENERATED_DIR}/{name}", 1, f"{passed} tests for {t['qname']} "
                                                                   f"({t['file']}:{t['line']}), all passing"))
                ok = True
                break
            last = out[-2500:]
            attempt_prompt = (prompt + f"\n\nYour previous tests failed:\n```python\n{code}\n```\n"
                              f"pytest output:\n```\n{last}\n```\nFix the tests (not the code) and return the "
                              "whole module again.")
        if not ok:
            logs.append(f"   dropped: no passing tests for {t['qname']} after {AI_ATTEMPTS} attempts")
            logs.append(last[-800:])
    status = "passed" if kept else "warned"
    return _result(status, found, "\n".join(logs),
                   summary={"targets": len(targets), "kept": len(kept), "files": kept},
                   command="model-written pytest for untested central code")


def _graph_py(c: Ctx) -> bool:
    return c.graph is not None and _py(c) and _pytests(c)


register(
    probe("py.import-smoke", "Import every module", "build",
          "Imports each module of the repo's packages in its own interpreter: import-time errors, missing "
          "dependencies and circular imports, without running a test.", _smoke("imports"), _packages,
          timeout=300, tags=("smoke", "fast")),
    probe("py.cli-smoke", "Console scripts answer --help", "build",
          "Every console script in pyproject/setup.cfg resolves to a callable and exits 0 on --help.",
          _smoke("cli"), _console_scripts, timeout=300, tags=("smoke", "cli")),
    probe("pytest.flaky", "Flaky and order-dependent tests", "tests",
          "Runs the suite three times (forward, reversed, forward) and reports tests whose outcome changes.",
          flaky, _pytests, tool="pytest", timeout=1800, tags=("flaky", "slow")),
    probe("pytest.isolation", "Tests that need another file", "tests",
          f"Runs each test file on its own (up to {MAX_ISOLATION_FILES}) and compares with the full suite: "
          "hidden dependencies on another file's fixtures or leftovers.", isolation, _pytests, tool="pytest",
          timeout=1800, tags=("isolation", "slow")),
    probe("ai.unit-tests", "Write tests for untested code (AI)", "tests",
          f"A model writes pytest tests for up to {AI_TARGETS} central functions no test reaches; files that pass "
          f"are kept in {GENERATED_DIR}/. Spends model credit and writes to the checkout, so operator only.",
          ai_unit_tests, _graph_py, tool="pytest", severity="warn", timeout=1200, tags=("ai", "coverage"),
          local_only=True),
)
