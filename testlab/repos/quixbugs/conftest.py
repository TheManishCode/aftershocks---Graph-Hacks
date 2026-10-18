"""Vendored from QuixBugs (see VENDORED.md). `--runslow` keeps upstream's switch for its slowest cases.

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
