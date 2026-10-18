"""Command line: index a repo, ask what breaks, gate a PR in CI, or serve the API / MCP server.

    aftershock index ../myrepo                       # incremental after the first run
    aftershock impact myrepo get_settings --change signature
    aftershock diff myrepo                           # working tree vs the indexed graph, as a PR comment
    aftershock tests myrepo --diff | xargs pytest    # only the tests that reach the change
    aftershock ci --base origin/main --out report.md --fail-on critical
    aftershock ask myrepo "why does main depend on get_settings?"
    aftershock eval myrepo --commits 300             # replay history: precision / recall of the predictions
    aftershock coverage myrepo                       # run the suite once under per-test coverage (runs repo code)
    aftershock run myrepo --diff                     # run only the selected tests, rank culprits for failures
    aftershock mutate myrepo --n 30                  # break functions for real: does selection catch it?
    aftershock heal myrepo --diff --apply            # run the selected tests; let Claude fix failures and reverify
    aftershock library myrepo add mylib ../my-tests  # index + select + run an external pytest library with the repo
    aftershock runs myrepo [RUN_ID]                  # recorded runs (every run/heal is stored in the graph)
    aftershock serve                                 # REST + /mcp on :8100
    aftershock mcp                                   # stdio MCP server for Claude Code / Cursor

The CLI runs as you, on your files: path confinement (AFTERSHOCK_REPO_ROOTS) guards the network API, so the CLI
widens it to the filesystem unless you set it yourself.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

LEVELS = ("low", "medium", "high", "critical")


def _out(res: dict, as_json: bool, text: str | None = None) -> None:
    if as_json or text is None:
        print(json.dumps(res, indent=2, default=str))
    else:
        print(text)


def _progress(stage: str, data: dict) -> None:
    detail = ", ".join(f"{k}={v}" for k, v in data.items() if isinstance(v, int | float | str))
    print(f"  {stage:<9} {detail}", file=sys.stderr)


def _index(path: Path, name: str | None, full: bool, history: bool, quiet: bool = False) -> dict:
    from . import tools as T
    from .ingest.pipeline import index_repo

    root = path.resolve()
    if not root.is_dir():
        raise T.ToolError(f"{path} is not a directory")
    repo = T.repo_name_for(root, name)
    t0 = time.perf_counter()
    rep = index_repo(root, repo, full=full, with_history=history, progress=None if quiet else _progress).as_dict()
    if not quiet:
        print(f"indexed {repo}: {rep['files']} files ({rep['parsed']} parsed), {rep['symbols']} symbols, "
              f"{rep['edges']} edges, {rep['resolution_rate']:.0%} of call sites resolved "
              f"({rep['repo_resolution_rate']:.0%} of those not provably into libraries/builtins) "
              f"in {time.perf_counter() - t0:.1f}s", file=sys.stderr)
    return rep


def cmd_index(a) -> int:
    from . import tools as T

    if a.target.startswith("https://"):
        rep = T.index(url=a.target, name=a.name, full=a.full, history=not a.no_history, progress=_progress)
    else:
        rep = _index(Path(a.target), a.name, a.full, not a.no_history)
    if a.json:
        _out(rep, True)
    return 0


def cmd_repos(a) -> int:
    from . import tools as T

    res = T.list_repos(include_lab=a.all)
    rows = res["repos"]
    text = "\n".join(f"{r['name']:<24} {r['files'] or 0:>6} files {r['symbols'] or 0:>7} symbols  "
                     f"{(r['resolution_rate'] or 0):.0%} resolved  {(r['commit'] or '')[:10]}"
                     f"{'  [lab]' if r.get('lab') else ''}" for r in rows)
    _out(res, a.json, text or "no repositories indexed yet: aftershock index <path>")
    return 0


def cmd_lab(a) -> int:
    from . import tools as T

    for name in a.repos:
        T.set_lab(name, not a.off)
    _out({"repos": a.repos, "lab": not a.off}, a.json,
         ("unhidden: " if a.off else "hidden from listings (eval still works): ") + ", ".join(a.repos))
    return 0


def cmd_impact(a) -> int:
    from . import tools as T

    res = T.run(T.impact_of, a.repo, a.targets, a.change, a.depth, markdown=True)
    _out(res, a.json, res.get("markdown") or _problems(res))
    return 0 if not res.get("error") else 2


def cmd_diff(a) -> int:
    from . import tools as T

    res = T.run(T.diff_impact, a.repo, a.rev, a.depth)
    _out(res, a.json, res["markdown"])
    return _gate(res["impact"], a.fail_on)


def cmd_tests(a) -> int:
    from . import tools as T

    res = T.select_tests(a.repo, a.targets or None, a.rev, diff_mode=a.diff)
    _out(res, a.json, "\n".join(res["files"]))
    if not a.json and not res["files"]:
        print(res["note"], file=sys.stderr)
    return 0


def cmd_path(a) -> int:
    from . import agent
    from . import tools as T

    res = T.run(T.explain_path, a.repo, a.source, a.target, a.depth)
    _out(res, a.json, agent._render_path(res, [a.source, a.target]))
    return 0 if res.get("found") else 1


def cmd_culprit(a) -> int:
    from . import agent
    from . import tools as T

    res = T.run(T.culprits, a.repo, a.failing, a.changed, a.limit)
    _out(res, a.json, agent._render_culprit(res))
    return 0


def cmd_overview(a) -> int:
    from . import agent
    from . import tools as T

    res = T.run(T.overview, a.repo)
    _out(res, a.json, agent._render_overview(res))
    return 0


def cmd_eval(a) -> int:
    from . import tools as T
    from .analysis import evaluate

    res = T.replay_eval(a.repo, a.commits, a.depth, a.max_files, progress=None if a.json else _progress)
    _out(res, a.json, evaluate.render(res))
    return 0


def _runtime(a) -> tuple:
    """(graph, checkout, interpreter) for the runtime commands, which execute the repo's own code."""
    from . import tools as T
    from .ingest.discover import libraries
    from .runtime.pytest_run import python_for

    g = T._graph(a.repo)
    props = T._repo_props(g)
    root = Path(props.get("root") or "")
    if not root.is_dir():
        raise T.ToolError("the indexed checkout is no longer on disk; re-index it")
    a.libs = libraries(props)
    return g, root, python_for(root, a.repo, a.python)


def cmd_coverage(a) -> int:
    from .runtime.pytest_run import record_coverage

    g, root, python = _runtime(a)
    res = record_coverage(g, root, python, a.pytest_args, timeout=a.timeout, progress=None if a.json else _progress,
                          libs=a.libs)
    _out(res, a.json, f"{a.repo}: {res['tests_run']} tests ran ({res['passed']} passed, {res['failed']} failed, "
                      f"{res['skipped']} skipped) in {res['seconds']:.1f}s\n"
                      f"recorded {res['edges']} test→symbol edges; {res['symbols_covered']} of {res['spans']} "
                      f"functions/methods ran under at least one test"
                      + (f"\n{res['unmatched_tests']} test ids did not match the graph (re-index?)"
                         if res["unmatched_tests"] else ""))
    return 0


def cmd_run(a) -> int:
    """Select the tests a change reaches, run only those, and explain any failure with culprit ranking."""
    from . import agent
    from . import tools as T
    from .runtime import runs
    from .runtime.pytest_run import node_to_symbol, run_selected

    g, root, python = _runtime(a)
    sel = T.select_tests(a.repo, a.targets or None, a.rev, diff_mode=a.diff)
    ids = [t["id"] for t in sel["tests"]]
    if not ids:
        _out({"selected": 0, **sel}, a.json, f"no tests selected: {sel['note']}")
        return 0
    if not a.json:
        print(f"  selected  {len(ids)} tests in {len(sel['files'])} files ({sel.get('runtime_tests', 0)} via "
              f"recorded coverage)", file=sys.stderr)
    out = run_selected(root, python, ids, timeout=a.timeout, libs=a.libs)
    by = out.by_outcome()
    failed = out.failed
    res = {"selected": len(ids), "files": sel["files"], "exit_code": out.exit_code, "seconds": out.seconds,
           "passed": len(by.get("passed", [])), "failed": len(failed), "skipped": len(by.get("skipped", [])),
           "failures": [{"test": r["nodeid"], "when": r["when"], "message": r.get("message", "")} for r in failed],
           "untested_seeds": sel["untested_seeds"], "note": sel["note"]}
    lines = [f"{res['passed']} passed, {res['failed']} failed, {res['skipped']} skipped "
             f"({len(ids)} selected tests, parametrized cases counted separately) in {out.seconds:.1f}s"]
    if sel["untested_seeds"]:
        lines.append("no test reaches: " + ", ".join(sel["untested_seeds"][:10]))
    if failed:
        lines.append("\nFailures")
        for f in res["failures"][:20]:
            msg = (f["message"].strip().splitlines() or [""])[-1][:200]
            lines.append(f"  ✗ {f['test']}  ({f['when']})\n      {msg}")
        suspects = T.run(T.culprits, a.repo, sorted({node_to_symbol(r["nodeid"]) for r in failed}),
                         a.changed or sel.get("seed_ids") or None, 10)
        res["culprits"] = suspects
        lines.append("\n" + agent._render_culprit(suspects))
    elif out.exit_code not in (0, 5):
        lines.append(f"pytest exit {out.exit_code}:\n{out.stdout_tail[-1500:]}")
    res["run_id"] = runs.record(g, out, mode="diff" if a.diff or not a.targets else "targets", root=root,
                                culprits=res.get("culprits"), changed=a.changed or sel.get("seed_ids"),
                                selected=len(ids))
    lines.append(f"\nrecorded as run {res['run_id']} (aftershock runs {a.repo} {res['run_id']})")
    _out(res, a.json, "\n".join(lines))
    return 1 if failed or out.exit_code not in (0, 5) else 0


def cmd_library(a) -> int:
    """Register a directory of pytest tests outside the repo; it is indexed, selected and run with the repo's own."""
    from . import tools as T

    if a.action == "list":
        res = T.test_libraries(a.repo)
        _out(res, a.json, "\n".join(f"{x['name']:<16} {x['tests']:>5} tests  {x['path']}"
                                    + ("" if x["on_disk"] else "  (missing)") for x in res["libraries"])
             or "no test libraries; add one with `aftershock library REPO add NAME DIR`")
        return 0
    if not a.name or (a.action == "add" and not a.path):
        raise T.ToolError(f"usage: aftershock library REPO {a.action} NAME" + (" DIR" if a.action == "add" else ""))
    res = T.library_set(a.repo, a.name, a.path if a.action == "add" else None)
    root = T._repo_props(T._graph(a.repo)).get("root")
    rep = T.index(root, name=a.repo, history=False, progress=None if a.json else _progress)
    lib = next((x for x in T.test_libraries(a.repo)["libraries"] if x["name"] == a.name), None)
    res = {**res, "indexed": {"files": rep.get("files"), "changed": len(rep.get("changed") or []),
                                  "removed": len(rep.get("removed") or [])}, "library": lib}
    _out(res, a.json, f"{a.action} {a.name}: " + (f"{lib['tests']} tests in {lib['files']} files indexed"
                                                 if lib else "removed from the index"))
    return 0


def cmd_runs(a) -> int:
    """Recorded test runs: the list, or one run's failures, suspects (with chains) and heal lineage."""
    from . import agent
    from . import tools as T

    if not a.run_id:
        res = T.test_runs(a.repo, a.limit)
        _out(res, a.json, "\n".join(
            f"{r['id']}  {time.strftime('%m-%d %H:%M', time.localtime(r['started']))}  {r['trigger']:<5} "
            f"{r['mode']:<8} {r['passed']:>5} passed {r['failed']:>4} failed  {r['seconds']:>6.1f}s"
            + (f"  retry of {r['parent']}" if r.get("parent") else "") for r in res["runs"]) or "no recorded runs")
        return 0
    res = T.run_detail(a.repo, a.run_id)
    lines = [f"run {res['id']} ({res['trigger']}, {res['mode']}): {res['passed']} passed, {res['failed']} failed, "
             f"{res['skipped']} skipped in {res['seconds']:.1f}s" + (f", retry of {res['parent']}" if res["parent"] else "")]
    for f in res["failures"][:20]:
        msg = (f["message"].strip().splitlines() or [""])[-1][:200]
        hist = res.get("history", {}).get(f["test"])
        lines.append(f"  ✗ {f['nodeid']}" + (f"  (failed {hist['failed']}/{hist['runs']} earlier runs)" if hist else "")
                     + f"\n      {msg}")
    if res["culprits"]:
        lines.append("\n" + agent._render_culprit(res["culprits"]))
    if res.get("heal_diff"):
        lines += ["", f"heal round {res.get('heal_round')} edit:", res["heal_diff"]]
    if res["retries"]:
        lines.append("\nre-runs: " + ", ".join(res["retries"]))
    _out(res, a.json, "\n".join(lines))
    return 0


def cmd_mutate(a) -> int:
    from . import tools as T
    from .runtime import mutate

    g, root, python = _runtime(a)
    res = mutate.evaluate(g, root, python, n=a.n, seed=a.seed, depth=T._depth(a.depth), timeout=a.timeout,
                          progress=None if a.json else _progress)
    lines = [f"{res['mutants']} mutants ({res['skipped']} skipped): {res['killed']} killed by the suite, "
             f"{res['survived']} survived (no test noticed)", "",
             f"{'selector':<10} {'recall':>7} {'caught':>7} {'tests':>8} {'suite':>7}"]
    for name, s in res["selectors"].items():
        lines.append(f"{name:<10} {s['recall']:>7.3f} {s['caught']:>7.3f} {s['selected']:>8.1f} "
                     f"{s['suite_share']:>7.2%}")
    survived = [r["id"] for r in res["rows"] if r["status"] == "survived"]
    if survived:
        lines += ["", "survived (untested behaviour):", *(f"  {s}" for s in survived[:20])]
    lines += ["", res["note"]]
    _out(res, a.json, "\n".join(lines))
    return 0


def cmd_testlab(a) -> int:
    """End-to-end scenarios with known answers: change → diff → impact → select → run → culprit, scored."""
    from . import testlab

    names = a.suites or testlab.suites()
    if a.list:
        rows = []
        for n in names:
            spec, scs = testlab.load(n)
            rows.append({"suite": n, "repo": spec["repo"], "runs_tests": spec.get("run", True),
                         "scenarios": [s.id for s in scs]})
        _out({"suites": rows}, a.json, "\n".join(
            f"{r['suite']:<10} {len(r['scenarios']):>3} scenarios on {r['repo']}"
            f"{'' if r['runs_tests'] else ' (static only)'}" for r in rows))
        return 0
    res = testlab.run(names, only=a.only, python=a.python, keep=a.keep, progress=None if a.json else _progress)
    lines = []
    for s in res["suites"]:
        m = s["summary"]
        lines.append(f"\n{s['suite']} ({s['repo']}): {m['passed']}/{m['scenarios']} scenarios pass, "
                     f"checks {m['checks']}, {s['seconds']}s")
        for r in s["scenarios"]:
            bad = [c for c in r["checks"] if c["status"] in ("fail", "gap", "gap-fixed")]
            mark = "✓" if r["ok"] else "✗"
            lines.append(f"  {mark} {r['id']:<34} {r.get('error') or ''}"
                         + (f"sel {r['selected']}/{r['suite_tests']}, caught {r['caught']}/{len(r['failing'])}, "
                            f"culprit #{r['culprit_rank'] or '-'}" if not r.get("error") and r.get("suite_tests")
                            else ""))
            lines += [f"      {c['status']:<9} {c['name']}: {c['detail']}" + (f"  [{c['gap']}]" if c.get("gap") else "")
                      for c in bad]
        figures = {k: m[k] for k in ("selection_recall", "selected_share", "culprit_top1", "culprit_top3")
                   if m[k] is not None}
        if figures:
            lines.append("  " + ", ".join(f"{k} {v}" for k, v in figures.items()))
    _out(res, a.json, "\n".join(lines).lstrip("\n"))
    return 0 if res["ok"] else 1


def cmd_heal(a) -> int:
    """Run the tests a change reaches; with --apply, let Claude propose and re-verify fixes for failures."""
    from . import tools as T
    from .analysis import heal
    from .runtime.pytest_run import node_to_symbol

    g, root, python = _runtime(a)
    sel = T.select_tests(a.repo, a.targets or None, a.rev, diff_mode=a.diff)
    ids = [t["id"] for t in sel["tests"]]
    if not ids:
        _out({"selected": 0, **sel}, a.json, f"no tests selected: {sel['note']}")
        return 0
    api_key = os.environ.get("ANTHROPIC_API_KEY") or heal.cli_backend()
    if a.apply and not api_key:
        print("aftershock: --apply given but neither ANTHROPIC_API_KEY nor the claude CLI is available; "
              "running read-only", file=sys.stderr)
    if not a.json:
        print(f"  selected  {len(ids)} tests in {len(sel['files'])} files ({sel.get('runtime_tests', 0)} via "
              f"recorded coverage)", file=sys.stderr)
    changed = a.changed or sel.get("seed_ids") or None
    from .runtime import runs

    def recorder(out, info: dict) -> str:
        cul = (T.run(T.culprits, a.repo, sorted({node_to_symbol(r["nodeid"]) for r in out.failed}), changed, 10)
               if out.failed else None)
        return runs.record(g, out, mode="heal", trigger="heal", root=root, culprits=cul, changed=changed,
                           parent=info.get("parent"), extra={"heal_step": info.get("step", ""),
                                                             "heal_round": info.get("round", 0),
                                                             "heal_suspect": info.get("suspect", ""),
                                                             "heal_diff": info.get("diff", "")})

    rep = heal.heal(g, root, python, ids, changed, apply=a.apply, anthropic_api_key=api_key,
                    max_rounds=a.max_rounds, timeout=a.timeout,
                    widen=lambda: T.wider_tests(a.repo, sel.get("seed_ids") or [], ids), libs=a.libs,
                    recorder=recorder)
    _out({**rep.as_dict(), "selected": len(ids)}, a.json, _render_heal(rep))
    return {"all_passed": 0, "fixed": 0}.get(rep.verdict, 1)


def _render_heal(rep) -> str:
    lines = []
    init = rep.initial or {}
    if init:
        lines.append(f"initial run: {init.get('passed', 0)} passed, {init.get('failed', 0)} failed, "
                     f"{init.get('skipped', 0)} skipped in {init.get('seconds', 0):.1f}s")
    for i, r in enumerate(rep.rounds, 1):
        mark = {"fixed": "✓", "partial": "~"}.get(r.outcome, "✗")
        lines.append(f"  round {i}: {mark} {r.outcome} — tried `{r.suspect.get('name')}` in {r.file} "
                     f"({r.before_failed} → {r.after_failed} failing){' [reverted]' if r.reverted else ''}")
        if r.diff_preview:
            lines.extend(f"           {ln}" for ln in r.diff_preview.rstrip().splitlines())
    if rep.widened:
        lines.append(f"  widened: {rep.widened} more test(s) reach the change by a longer path; ran them too")
    lines.append("")
    lines.append(f"verdict: {rep.verdict}" + (f" — {rep.note}" if rep.note else ""))
    if rep.final and rep.final.get("failing") and rep.verdict != "fixed":
        lines.append("still failing: " + ", ".join(rep.final["failing"][:10]))
    return "\n".join(lines)


def cmd_ask(a) -> int:
    from . import agent

    def emit(kind: str, data: dict) -> None:
        if kind == "tool" and not a.json:
            print(f"  → {data['name']}({json.dumps(data['input'], default=str)[:120]})", file=sys.stderr)

    res = agent.ask(a.repo, " ".join(a.question), emit)
    _out(res, a.json, res["answer"])
    return 0


def cmd_ci(a) -> int:
    """Index the PR's merge-base into the graph, diff HEAD against it, write the comment, gate on risk."""
    from . import tools as T
    from .analysis import diff, report
    from .graph import get_store

    root = Path(a.path).resolve()
    git = ["git", "-C", str(root)]
    try:
        base = subprocess.run([*git, "merge-base", a.base, "HEAD"], check=True, capture_output=True, text=True,
                              timeout=60).stdout.strip()
    except subprocess.CalledProcessError as e:
        print(f"cannot find merge-base of {a.base} and HEAD (fetch with enough depth): {e.stderr.strip()}",
              file=sys.stderr)
        return 2
    name = T.repo_name_for(root, a.name)
    store = get_store()
    have = T._repo_props(store.repo(name)).get("commit") if store.repo(name).exists() else None
    if have != base:
        with tempfile.TemporaryDirectory(prefix="aftershock-base-") as tmp:
            wt = Path(tmp) / "base"
            subprocess.run([*git, "worktree", "add", "--detach", "--quiet", str(wt), base], check=True, timeout=120)
            try:
                _index(wt, name, full=True, history=not a.no_history, quiet=a.quiet)
            finally:
                subprocess.run([*git, "worktree", "remove", "--force", str(wt)], check=False, timeout=60)
            # the snapshot came from a throwaway worktree; point the repo back at the real checkout
            store.repo(name).rw("upsert_repo", {"name": name, "props": {"root": str(root)}})
    g = store.repo(name)
    res = T.run(diff.analyze, g, root, "HEAD", T._depth(a.depth))
    md = report.render(res["impact"], changes=res["changes"], link=a.link)
    if a.out:
        Path(a.out).write_text(md + "\n", encoding="utf-8")
    if a.json_out:
        Path(a.json_out).write_text(json.dumps(res, indent=2, default=str), encoding="utf-8")
    if not a.quiet:
        print(md)
    return _gate(res["impact"], a.fail_on)


def _gate(impact: dict, fail_on: str | None) -> int:
    if not fail_on or not impact or not impact.get("risk"):
        return 0
    level = impact["risk"]["level"]
    if LEVELS.index(level) >= LEVELS.index(fail_on):
        print(f"aftershock: risk {impact['risk']['score']} ({level}) is at or above --fail-on {fail_on}",
              file=sys.stderr)
        return 3
    return 0


def _problems(res: dict) -> str:
    from . import agent

    return agent._problems(res)


def cmd_serve(a) -> int:
    import uvicorn

    uvicorn.run("aftershock.api:app", host=a.host, port=a.port, log_level="info", proxy_headers=True)
    return 0


def cmd_mcp(a) -> int:
    from .mcp_server import main

    main(a.transport)
    return 0


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="aftershock", description="What breaks if I change this? Answered from a graph.")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", help="machine-readable output")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("index", parents=[common], help="parse a repo into the graph (incremental)")
    s.add_argument("target", help="local path, or an https git URL to clone")
    s.add_argument("--name")
    s.add_argument("--full", action="store_true", help="re-parse every file")
    s.add_argument("--no-history", action="store_true", help="skip git churn / co-change / owners")
    s.set_defaults(fn=cmd_index)

    s = sub.add_parser("repos", parents=[common], help="list indexed repositories")
    s.add_argument("--all", action="store_true", help="include lab (benchmark) graphs")
    s.set_defaults(fn=cmd_repos)

    s = sub.add_parser("lab", parents=[common], help="mark benchmark graphs: hidden from the app, still usable by eval")
    s.add_argument("repos", nargs="+")
    s.add_argument("--off", action="store_true", help="show them again")
    s.set_defaults(fn=cmd_lab)

    s = sub.add_parser("impact", parents=[common], help="what breaks if these symbols change")
    s.add_argument("repo")
    s.add_argument("targets", nargs="+")
    s.add_argument("--change", choices=("body", "signature", "rename", "delete"), default="body")
    s.add_argument("--depth", type=int)
    s.set_defaults(fn=cmd_impact)

    s = sub.add_parser("diff", parents=[common], help="impact of the working tree (or --rev) against the indexed graph")
    s.add_argument("repo")
    s.add_argument("--rev")
    s.add_argument("--depth", type=int)
    s.add_argument("--fail-on", choices=LEVELS)
    s.set_defaults(fn=cmd_diff)

    s = sub.add_parser("tests", parents=[common], help="test files that statically reach a change")
    s.add_argument("repo")
    s.add_argument("targets", nargs="*")
    s.add_argument("--rev")
    s.add_argument("--diff", action="store_true", help="use the working-tree diff even if targets are given")
    s.set_defaults(fn=cmd_tests)

    s = sub.add_parser("path", parents=[common], help="why does SOURCE depend on TARGET")
    s.add_argument("repo")
    s.add_argument("source")
    s.add_argument("target")
    s.add_argument("--depth", type=int, default=8)
    s.set_defaults(fn=cmd_path)

    s = sub.add_parser("culprit", parents=[common], help="rank suspects for failing tests")
    s.add_argument("repo")
    s.add_argument("failing", nargs="+")
    s.add_argument("--changed", nargs="*")
    s.add_argument("--limit", type=int, default=15)
    s.set_defaults(fn=cmd_culprit)

    s = sub.add_parser("overview", parents=[common], help="subsystems, cycles, load-bearing code")
    s.add_argument("repo")
    s.set_defaults(fn=cmd_overview)

    s = sub.add_parser("ask", parents=[common], help="ask a question in plain English")
    s.add_argument("repo")
    s.add_argument("question", nargs="+")
    s.set_defaults(fn=cmd_ask)

    s = sub.add_parser("eval", parents=[common], help="replay recent commits and score the predictions")
    s.add_argument("repo")
    s.add_argument("--commits", type=int, default=200)
    s.add_argument("--depth", type=int, default=3)
    s.add_argument("--max-files", type=int, default=12, help="skip commits touching more source files (bulk edits)")
    s.set_defaults(fn=cmd_eval)

    runtime = argparse.ArgumentParser(add_help=False)
    runtime.add_argument("--python", help="interpreter that can import the repo and pytest (default: the repo's "
                                          ".venv, then .aftershock/envs/<repo>)")
    runtime.add_argument("--timeout", type=int, default=1800, help="seconds per pytest run")

    s = sub.add_parser("coverage", parents=[common, runtime],
                       help="run the test suite under per-test coverage; record which tests run which code")
    s.add_argument("repo")
    s.add_argument("pytest_args", nargs=argparse.REMAINDER, help="extra pytest args (after the repo)")
    s.set_defaults(fn=cmd_coverage)

    s = sub.add_parser("run", parents=[common, runtime],
                       help="run only the tests a change reaches; rank culprits for failures")
    s.add_argument("repo")
    s.add_argument("targets", nargs="*")
    s.add_argument("--rev")
    s.add_argument("--diff", action="store_true", help="use the working-tree diff even if targets are given")
    s.add_argument("--changed", nargs="*", help="symbols to boost in culprit ranking (default: the change's seeds)")
    s.set_defaults(fn=cmd_run)

    s = sub.add_parser("mutate", parents=[common, runtime],
                       help="break sampled functions in a scratch copy; score test selection against real failures")
    s.add_argument("repo")
    s.add_argument("--n", type=int, default=30)
    s.add_argument("--seed", type=int, default=7)
    s.add_argument("--depth", type=int)
    s.set_defaults(fn=cmd_mutate)

    s = sub.add_parser("heal", parents=[common, runtime],
                       help="run the tests a change reaches; with --apply, let Claude fix and re-verify failures")
    s.add_argument("repo")
    s.add_argument("targets", nargs="*")
    s.add_argument("--rev")
    s.add_argument("--diff", action="store_true", help="use the working-tree diff even if targets are given")
    s.add_argument("--changed", nargs="*", help="symbols to boost in culprit ranking (default: the change's seeds)")
    s.add_argument("--apply", action="store_true", help="let Claude write fixes (needs ANTHROPIC_API_KEY); "
                                                        "without it, heal only reports, like `run`")
    s.add_argument("--max-rounds", type=int, default=3, help="Claude-proposed fix attempts before giving up")
    s.set_defaults(fn=cmd_heal)

    s = sub.add_parser("library", parents=[common],
                       help="register an external pytest test library with a repo (indexed, selected, run with it)")
    s.add_argument("repo")
    s.add_argument("action", choices=("list", "add", "remove"))
    s.add_argument("name", nargs="?")
    s.add_argument("path", nargs="?", help="the library's directory (add)")
    s.set_defaults(fn=cmd_library)

    s = sub.add_parser("runs", parents=[common], help="recorded test runs, or one run's failures and suspects")
    s.add_argument("repo")
    s.add_argument("run_id", nargs="?")
    s.add_argument("--limit", type=int, default=20)
    s.set_defaults(fn=cmd_runs)

    s = sub.add_parser("testlab", parents=[common],
                       help="run the end-to-end scenario suites in testlab/ (known answers; runs fixture tests)")
    s.add_argument("suites", nargs="*", help="suite names (default: all); `--list` shows them")
    s.add_argument("--only", help="run scenarios whose id contains this")
    s.add_argument("--python", help="interpreter for the fixtures' pytest suites (default: this one)")
    s.add_argument("--keep", action="store_true", help="keep the testlab-* graphs and scratch checkouts")
    s.add_argument("--list", action="store_true", help="list suites and scenarios, run nothing")
    s.set_defaults(fn=cmd_testlab)

    s = sub.add_parser("ci", parents=[common], help="index the merge-base, analyze HEAD, write a PR comment, gate on risk")
    s.add_argument("--path", default=".")
    s.add_argument("--base", default="origin/main")
    s.add_argument("--name")
    s.add_argument("--out", help="write the Markdown comment here")
    s.add_argument("--json-out", help="write the full result here")
    s.add_argument("--link", help="URL prefix for file links, e.g. https://github.com/o/r/blob/<sha>")
    s.add_argument("--depth", type=int)
    s.add_argument("--fail-on", choices=LEVELS)
    s.add_argument("--no-history", action="store_true")
    s.add_argument("--quiet", action="store_true")
    s.set_defaults(fn=cmd_ci)

    s = sub.add_parser("serve", parents=[common], help="REST API + streamable-HTTP MCP at /mcp")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8100)
    s.set_defaults(fn=cmd_serve)

    s = sub.add_parser("mcp", parents=[common], help="MCP server over stdio")
    s.add_argument("--transport", choices=("stdio", "streamable-http"), default="stdio")
    s.set_defaults(fn=cmd_mcp)
    return p


def main(argv: list[str] | None = None) -> int:
    a = parser().parse_args(argv)
    if a.cmd != "serve":
        os.environ.setdefault("AFTERSHOCK_REPO_ROOTS", os.sep)  # local user, local files: see module docstring
    from . import tools as T
    from .graph import GraphUnavailable
    from .runtime.pytest_run import RuntimeErrorReport

    try:
        return a.fn(a)
    except (T.ToolError, ValueError, RuntimeErrorReport) as e:
        print(f"aftershock: {e}", file=sys.stderr)
        return 2
    except GraphUnavailable as e:
        print(f"aftershock: graph unavailable ({e}). Start it with `docker compose up -d falkordb`.", file=sys.stderr)
        return 4


if __name__ == "__main__":
    sys.exit(main())
