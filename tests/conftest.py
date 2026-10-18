"""Shared fixtures. Graph tests index `tests/fixtures/mini` (a 9-file repo whose call graph is known by hand) into
throwaway `pytest-*` graphs and drop them afterwards. They skip when FalkorDB isn't reachable."""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

import pytest

collect_ignore = ["fixtures"]  # fixture repos have their own test_*.py; they are data, not tests

MINI = Path(__file__).parent / "fixtures" / "mini"
SCRATCH = Path(tempfile.mkdtemp(prefix="aftershock-tests-"))

# Must happen before anything caches settings: let tool-level path confinement see the fixture and scratch dirs.
os.environ["AFTERSHOCK_REPO_ROOTS"] = os.pathsep.join([str(MINI.parent), str(SCRATCH)])
os.environ["AFTERSHOCK_CACHE_DIR"] = str(SCRATCH / ".cache")
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("AFTERSHOCK_API_KEY", None)

from aftershock.config import get_settings  # noqa: E402
from aftershock.graph import get_store  # noqa: E402

get_settings.cache_clear()


def _graph_up() -> bool:
    try:
        return get_store().ping()
    except Exception:
        return False


GRAPH_UP = _graph_up()
needs_graph = pytest.mark.skipif(not GRAPH_UP, reason="FalkorDB not reachable (docker compose up -d falkordb)")


def index_copy(name: str, src: Path = MINI) -> Path:
    """Copy a fixture into the scratch dir and index it (no git history) under `name`."""
    from aftershock.ingest.pipeline import index_repo

    dest = SCRATCH / name
    shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(src, dest)
    index_repo(dest, name, full=True, with_history=False)
    return dest


@pytest.fixture(scope="session")
def mini() -> str:
    """The mini fixture indexed once for read-only tests. Yields the repo name."""
    if not GRAPH_UP:
        pytest.skip("FalkorDB not reachable")
    name = "pytest-mini"
    index_copy(name)
    yield name
    get_store().drop_repo(name)


@pytest.fixture
def scratch_repo(request):
    """A private, mutable indexed copy for tests that edit files. Yields (name, root)."""
    if not GRAPH_UP:
        pytest.skip("FalkorDB not reachable")
    name = f"pytest-{request.node.name[:40].replace('_', '-')}".strip("-")
    root = index_copy(name)
    yield name, root
    get_store().drop_repo(name)
    shutil.rmtree(root, ignore_errors=True)


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(SCRATCH, ignore_errors=True)
