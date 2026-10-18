"""Vendor QuixBugs (Lin et al., 2017: 40 programs, one real bug each, with pytest tests) into testlab.

    git clone https://github.com/jkoppel/QuixBugs ../_refs/QuixBugs
    python scripts/vendor_quixbugs.py ../_refs/QuixBugs

Writes `testlab/repos/quixbugs/` (the *correct* programs as the package `quixbugs`, their tests rewritten to import it,
the JSON cases) and `testlab/bugs/quixbugs/<program>.py` (each buggy version, kept outside the indexed repo). A
scenario replaces one correct program with its buggy twin, so the change, the failing tests and the culprit are all
known. Re-running overwrites both directories.
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
REPO = HERE / "testlab" / "repos" / "quixbugs"
BUGS = HERE / "testlab" / "bugs" / "quixbugs"

CONFTEST = '''"""Vendored from QuixBugs (see VENDORED.md). `--runslow` keeps upstream's switch for its slowest cases.

Every test gets a wall-clock limit: several buggy programs loop forever, and a hang must fail one test, not the run.
"""

import signal

import pytest

LIMIT_S = 5


def pytest_addoption(parser):
    parser.addoption("--runslow", action="store_true", help="run slow tests")


def pytest_configure(config):
    pytest.run_slow = config.getoption("--runslow")


def _expire(signum, frame):
    raise TimeoutError(f"test exceeded {LIMIT_S}s (likely an infinite loop)")


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_call(item):
    old = signal.signal(signal.SIGALRM, _expire)
    signal.setitimer(signal.ITIMER_REAL, LIMIT_S)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)
'''

LOADER = '''import json
from pathlib import Path


def load_json_testcases(algorithm):
    path = Path(__file__).parent.parent / "testcases" / f"{algorithm}.json"
    with open(path) as data_file:
        return [json.loads(line) for line in data_file]
'''

SELECT = re.compile(
    r"if pytest\.use_correct:\n\s+from correct_python_programs\.(\w+) import (\w+)\nelse:\n\s+from python_programs\.\w+ import \w+\n"
)


def _rewrite_test(src: str) -> str:
    src = SELECT.sub(lambda m: f"from quixbugs.{m[1]} import {m[2]}\n", src)
    src = src.replace("from load_testdata import", "from tests.load_testdata import")
    src = src.replace("from node import Node", "from quixbugs.node import Node")
    if "use_correct" in src or "python_programs" in src:
        raise ValueError("unrecognized import shape")
    return src


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("src", type=Path, help="a QuixBugs checkout")
    a = ap.parse_args()
    src = a.src.resolve()
    commit = subprocess.run(["git", "-C", str(src), "rev-parse", "HEAD"], capture_output=True, text=True,
                            check=True).stdout.strip()
    shutil.rmtree(REPO, ignore_errors=True)
    shutil.rmtree(BUGS, ignore_errors=True)
    (REPO / "quixbugs").mkdir(parents=True)
    (REPO / "tests").mkdir()
    (REPO / "testcases").mkdir()
    BUGS.mkdir(parents=True)

    programs = []
    for t in sorted((src / "python_testcases").glob("test_*.py")):
        name = t.stem.removeprefix("test_")
        correct, buggy = src / "correct_python_programs" / f"{name}.py", src / "python_programs" / f"{name}.py"
        if not (correct.is_file() and buggy.is_file()):
            print(f"skip {name}: no correct/buggy pair", file=sys.stderr)
            continue
        programs.append(name)
        shutil.copy(correct, REPO / "quixbugs" / f"{name}.py")
        shutil.copy(buggy, BUGS / f"{name}.py")
        (REPO / "tests" / t.name).write_text(_rewrite_test(t.read_text()))
        case = src / "json_testcases" / f"{name}.json"
        if case.is_file():
            shutil.copy(case, REPO / "testcases" / case.name)
    shutil.copy(src / "python_programs" / "node.py", REPO / "quixbugs" / "node.py")
    (REPO / "quixbugs" / "__init__.py").write_text("")
    (REPO / "tests" / "__init__.py").write_text("")
    (REPO / "tests" / "load_testdata.py").write_text(LOADER)
    (REPO / "conftest.py").write_text(CONFTEST)
    (REPO / "pytest.ini").write_text("[pytest]\ntestpaths = tests\n")
    shutil.copy(src / "LICENSE", REPO / "LICENSE")
    (REPO / "VENDORED.md").write_text(
        f"# QuixBugs (vendored)\n\nSource: https://github.com/jkoppel/QuixBugs at `{commit}`, MIT (see LICENSE and "
        "upstream `legal_notes.txt`).\nPaper: Lin, Koppel, Chen, Solar-Lezama, *QuixBugs: a multi-lingual program "
        "repair benchmark set based on the Quixey Challenge*, SPLASH 2017.\n\nChanges: the correct programs became "
        "the package `quixbugs`; tests import it instead of switching on `--correct`; a per-test 5s alarm was "
        "added because buggy versions can loop forever. The buggy versions live in `testlab/bugs/quixbugs/`.\n\n"
        f"Generated by `scripts/vendor_quixbugs.py` ({len(programs)} programs).\n")
    print(f"vendored {len(programs)} programs from {commit[:12]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
