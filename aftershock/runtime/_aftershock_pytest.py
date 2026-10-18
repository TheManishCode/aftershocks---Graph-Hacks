"""pytest plugin loaded into the *target* repo's interpreter (`-p _aftershock_pytest`). Imports only pytest/coverage.

- Under `coverage run`, it labels every line a test executes with the test's node id (a coverage.py dynamic context),
  so the data file answers "which tests ran this line" (the per-test coverage Datadog TIA and pytest-testmon record).
- With AFTERSHOCK_RESULTS set, it appends one JSON line per test outcome to that file.
"""

import json
import os

import pytest

try:
    import coverage
except ImportError:  # running tests without coverage
    coverage = None


def _switch(ctx: str) -> None:
    cov = coverage.Coverage.current() if coverage else None
    if cov is not None:
        cov.switch_context(ctx)


_paths = {}  # nodeid -> the test file on disk: a file outside --rootdir gets a `../`-style nodeid


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_protocol(item, nextitem):
    _paths[item.nodeid] = str(item.path)
    _switch(item.nodeid)  # setup, call and teardown all count: fixtures run repo code too
    yield
    _switch("")


def pytest_runtest_logreport(report):
    path = os.environ.get("AFTERSHOCK_RESULTS")
    if not path or (report.when != "call" and report.outcome == "passed"):
        return
    row = {"nodeid": report.nodeid, "when": report.when, "outcome": report.outcome,
           "seconds": round(report.duration, 4), "path": _paths.get(report.nodeid)}
    if report.failed:
        row["message"] = (getattr(report, "longreprtext", "") or "")[-1500:]
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row) + "\n")
