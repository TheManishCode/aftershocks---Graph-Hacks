"""Command line: index a repo, ask what breaks, gate a PR in CI, or serve the API / MCP server.

    aftershock index ../myrepo                       # incremental after the first run
    aftershock impact myrepo get_settings --change signature
    aftershock diff myrepo                           # working tree vs the indexed graph, as a PR comment
    aftershock tests myrepo --diff | xargs pytest    # only the tests that reach the change
    aftershock ci --base origin/main --out report.md --fail-on critical
    aftershock ask myrepo "why does main depend on get_settings?"
    aftershock eval myrepo --commits 300             # replay history: precision / recall of the predictions
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

    try:
        return a.fn(a)
    except (T.ToolError, ValueError) as e:
        print(f"aftershock: {e}", file=sys.stderr)
        return 2
    except GraphUnavailable as e:
        print(f"aftershock: graph unavailable ({e}). Start it with `docker compose up -d falkordb`.", file=sys.stderr)
        return 4


if __name__ == "__main__":
    sys.exit(main())
