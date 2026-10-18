# Plant real one-line bugs in a click checkout, run `aftershock heal --diff --apply` on each, and score every step
# against the full test suite. Usage (the checkout must be clean and indexed BEFORE planting, since --diff compares
# the working tree with the graph):
#   git clone https://github.com/pallets/click.git /tmp/click && cd /tmp/click && git checkout 2247b35ea1
#   uv venv /tmp/click/.venv && uv pip install --python /tmp/click/.venv/bin/python -e /tmp/click pytest
#   aftershock index /tmp/click --name zz-click-heal
#   AFTERSHOCK_REPO_ROOTS=/tmp PYTHONPATH=. .venv/bin/python scripts/heal_bench.py zz-click-heal out.json
# The checkout is reset with `git checkout .` between cases, so it refuses to run on a dirty tree. Each fix is made
# by Claude (ANTHROPIC_API_KEY or the claude CLI); "exact_revert" means the fixed file is byte-identical to the
# original, "full_suite_after" counts failures in the WHOLE suite after the fix, not just the selected tests.
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from aftershock import tools as T
from aftershock.runtime.pytest_run import python_for

HERE = Path(__file__).resolve().parent.parent

CASES = [  # (symbol the bug is in, file, original text, planted text); each fails at least one test at 2247b35ea1
    ("IntRange._clamp", "src/click/types.py", "        return bound + dir\n", "        return bound - dir\n"),
    ("_split_opt", "src/click/parser.py", "        return opt[:2], opt[2:]\n", "        return opt[:1], opt[2:]\n"),
    ("join_options", "src/click/formatting.py", "    rv.sort(key=lambda x: x[0])\n", "    rv.sort(key=lambda x: -x[0])\n"),
    ("Choice.shell_complete", "src/click/types.py",
     "            matched = (c for c in str_choices if c.startswith(incomplete))\n",
     "            matched = (c for c in str_choices if c.endswith(incomplete))\n"),
    ("make_str", "src/click/utils.py", "    return str(value)\n\n\ndef _make_default", "    return repr(value)\n\n\ndef _make_default"),
    ("_build_prompt", "src/click/termui.py", """        prompt += f" ({', '.join(map(str, type.choices))})"\n""",
     """        prompt += f" ({','.join(map(str, type.choices))})"\n"""),
]


def failing_full_suite(repo: Path, python: str) -> set[str]:
    p = subprocess.run([python, "-m", "pytest", "-q", "-p", "no:cacheprovider", "-rf"], cwd=repo,
                       capture_output=True, text=True)
    return {ln.split()[1] for ln in p.stdout.splitlines() if ln.startswith("FAILED ")}


def main() -> int:
    graph, out_path = sys.argv[1], Path(sys.argv[2])
    repo = Path(T._repo_props(T._graph(graph)).get("root") or "")
    python = python_for(repo, graph, None)
    status = ["git", "-C", str(repo), "status", "--porcelain", "--untracked-files=no"]
    if subprocess.run(status, capture_output=True, text=True).stdout:
        print(f"{repo} has uncommitted changes; this script resets the tree between cases", file=sys.stderr)
        return 2
    rows = []
    for name, file, old, new in CASES:
        subprocess.run(["git", "checkout", "-q", "."], cwd=repo, check=True)
        f = repo / file
        text = f.read_text()
        assert text.count(old) == 1, (name, "plant site not unique")
        f.write_text(text.replace(old, new))
        truth = failing_full_suite(repo, python)
        t0 = time.time()
        p = subprocess.run([str(HERE / ".venv/bin/aftershock"), "heal", graph, "--diff", "--apply", "--json"], cwd=HERE,
                           capture_output=True, text=True, env=os.environ)
        secs = time.time() - t0
        try:
            rep = json.loads(p.stdout)
        except json.JSONDecodeError:
            rep = {"verdict": "error", "note": (p.stdout + p.stderr)[-400:]}
        init = rep.get("initial") or {}
        first = (rep.get("rounds") or [{}])[0].get("suspect", {}).get("name")
        after = failing_full_suite(repo, python) if rep.get("verdict") == "fixed" else truth
        rows.append({
            "bug": name, "file": file, "suite_failing": len(truth), "selected": rep.get("selected"),
            "widened": rep.get("widened", 0), "selected_failing": init.get("failed", 0), "rank1_suspect": first,
            "rank1_correct": bool(first) and first == name, "rounds": len(rep.get("rounds") or []),
            "verdict": rep.get("verdict"), "full_suite_after": len(after), "exact_revert": f.read_text() == text,
            "seconds": round(secs, 1), "note": rep.get("note", "")[:200],
        })
        print(json.dumps(rows[-1]), flush=True)
    subprocess.run(["git", "checkout", "-q", "."], cwd=repo, check=True)
    out_path.write_text(json.dumps(rows, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
