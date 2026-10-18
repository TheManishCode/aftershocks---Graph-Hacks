"""Incremental indexing and symbol-level diff detection on private copies of the mini fixture."""

from __future__ import annotations

from aftershock import tools as T
from aftershock.analysis import diff
from aftershock.graph import get_store
from aftershock.ingest.pipeline import index_repo

from .conftest import needs_graph

pytestmark = needs_graph


def edges(name: str) -> set[tuple[str, str, str]]:
    g = get_store().repo(name)
    rows = g.user_query("MATCH (a:Symbol)-[e:CALLS]->(b:Symbol) RETURN a.qname AS a, e.how AS how, b.qname AS b")
    return {(r["a"], r["how"], r["b"]) for r in rows}


def test_resolved_edges_match_source(mini):
    e = edges(mini)
    assert ("get_user", "module-attr", "load_user") in e
    assert ("load_user", "import", "connect") in e
    assert ("ReportJob.run", "local", "load_user") in e
    assert ("Price", "import", "formatPrice") in e
    assert ("Page", "local", "Price") in e  # JSX element usage
    assert not any(a == "health" for a, _, _ in e)  # health calls nothing in the repo


def test_reindex_without_changes_parses_nothing(scratch_repo):
    name, root = scratch_repo
    rep = index_repo(root, name, with_history=False)
    assert rep.parsed == 0 and not rep.changed and not rep.removed


def test_edit_reparses_only_that_file_and_keeps_inbound_edges(scratch_repo):
    name, root = scratch_repo
    p = root / "shop" / "db.py"
    p.write_text(p.read_text().replace("return Store(url)", "store = Store(url)\n    return store"))
    rep = index_repo(root, name, with_history=False)
    assert rep.parsed == 1 and rep.changed == ["shop/db.py"]
    assert ("load_user", "import", "connect") in edges(name)  # callers in untouched files still link


def test_deleted_file_is_removed(scratch_repo):
    name, root = scratch_repo
    (root / "web" / "app" / "page.tsx").unlink()
    rep = index_repo(root, name, with_history=False)
    assert rep.removed == ["web/app/page.tsx"]
    assert not any(a == "Price" for a, _, _ in edges(name))


def test_diff_classifies_symbol_changes(scratch_repo):
    name, root = scratch_repo
    db = root / "shop" / "db.py"
    db.write_text(db.read_text().replace("def connect(url):", "def connect(url, timeout=5):"))
    api = root / "shop" / "api.py"
    src = api.read_text().replace('return {"ok": True}', 'return {"ok": True, "v": 2}')
    src = src.replace("def _unused_helper():\n    return 42\n", "")
    api.write_text(src + "\n\ndef added_endpoint():\n    return None\n")
    cs = diff.detect(get_store().repo(name), root).as_dict()
    kinds = {c["qname"]: c["change"] for c in cs["symbols"]}
    assert kinds == {"connect": "signature", "health": "body", "_unused_helper": "delete", "added_endpoint": "added"}


def test_diff_impact_end_to_end(scratch_repo):
    name, root = scratch_repo
    db = root / "shop" / "db.py"
    db.write_text(db.read_text().replace("def connect(url):", "def connect(url, *, pool):"))
    res = T.diff_impact(name)
    assert {i["name"] for i in res["impact"]["impacted"]} >= {"load_user", "get_user"}
    assert "connect" in res["markdown"]


def test_clean_tree_has_no_changes(scratch_repo):
    name, root = scratch_repo
    res = T.diff_impact(name)
    assert not res["changes"]["symbols"]


def test_path_confinement(tmp_path):
    try:
        T.allowed_path("/etc")
    except T.ToolError as e:
        assert "/etc" not in str(e)  # never echo server paths back
    else:
        raise AssertionError("escaped the allowed roots")


def test_clone_url_validation():
    for bad in ("http://github.com/a/b", "https://user:pw@github.com/a/b", "https://evil.example/a/b",
                "file:///etc/passwd", "https://github.com/onlyowner", "https://github.com/a/../b", "ext::sh -c x"):
        try:
            T.check_url(bad)
        except T.ToolError:
            continue
        raise AssertionError(bad)
    assert T.check_url("https://github.com/falkordb/falkordb.git") == "falkordb"


def _git(root, *args):
    import subprocess

    subprocess.run(["git", "-C", str(root), "-c", "user.name=t", "-c", "user.email=t@x", *args],
                   check=True, capture_output=True)


def test_ci_indexes_merge_base_and_gates(tmp_path, capsys):
    import shutil

    from aftershock import cli
    from aftershock.graph import get_store

    from .conftest import MINI, SCRATCH

    root = SCRATCH / "ci-repo"
    shutil.rmtree(root, ignore_errors=True)
    shutil.copytree(MINI, root)
    _git(root, "init", "-q", "-b", "main")
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "base")
    _git(root, "checkout", "-qb", "feature")
    db = root / "shop" / "db.py"
    db.write_text(db.read_text().replace("def connect(url):", "def connect(url, *, pool):"))
    _git(root, "commit", "-qam", "change")
    out = tmp_path / "c.md"
    try:
        code = cli.main(["ci", "--path", str(root), "--base", "main", "--name", "pytest-ci", "--no-history",
                         "--quiet", "--out", str(out), "--fail-on", "high"])
        assert code == 3  # a required kw-only param breaks load_user -> high risk
        md = out.read_text()
        assert "`load_user`" in md and "signature changed" in md
        props = get_store().repo("pytest-ci").ro("repo")[0]["repo"]
        assert props["root"] == str(root) and props["commit"]  # not the deleted worktree; commit recorded w/o history
        assert cli.main(["ci", "--path", str(root), "--base", "main", "--name", "pytest-ci", "--quiet"]) == 0
    finally:
        get_store().drop_repo("pytest-ci")
