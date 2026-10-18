"""Analysis against the mini fixture, whose dependency graph is known by hand:

    get_user --module-attr--> load_user --import--> connect --new--> Store
    ReportJob.run --local--> load_user;  ReportJob INHERITS Job;  ReportJob.run OVERRIDES Job.run
    run_job(job: Job) --inferred--> Job.run, so it can dispatch to ReportJob.run
    test_get_user -> get_user;  test_connect -> connect;  test_health -> health
    Page --jsx--> Price --import--> formatPrice
"""

from __future__ import annotations

from aftershock import tools as T

from .conftest import needs_graph

pytestmark = needs_graph


def names(rows: list[dict]) -> set[str]:
    return {r["name"] for r in rows}


def test_impact_reaches_exact_transitive_callers(mini):
    res = T.impact_of(mini, ["connect"], "signature")
    assert names(res["impacted"]) == {"load_user", "get_user", "ReportJob.run", "run_job"}
    assert names(res["tests"]) == {"test_connect", "test_get_user"}  # test_health does not reach connect
    direct = next(i for i in res["impacted"] if i["name"] == "load_user")
    assert direct["hop"] == 1 and direct["tier"] in ("definite", "likely")
    far = next(i for i in res["impacted"] if i["name"] == "get_user")
    assert far["hop"] == 2 and far["p"] < direct["p"]  # probability decays with distance


def test_node_cap_keeps_the_strongest_of_an_overflowing_hop(mini, monkeypatch):
    from aftershock.analysis import impact

    monkeypatch.setitem(impact.weights(), "max_nodes", 2)
    res = T.impact_of(mini, ["connect"], "signature")
    assert res["truncated"]
    assert len(res["impacted"]) + len(res["tests"]) == 1  # seed + the strongest dependent, not an emptied hop


def test_import_only_lists_importers_without_a_resolved_edge(mini):
    res = T.impact_of(mini, ["Job"], "signature")
    assert res["import_only"] == [{"file": "shop/api.py", "imports": "shop/service.py", "names": ["service"], "line": 1}]
    assert T.impact_of(mini, ["connect"], "signature")["import_only"] == []  # every importer already has a call edge


def test_changing_an_override_reaches_callers_of_the_base_method(mini):
    res = T.impact_of(mini, ["ReportJob.run"], "body")
    hit = next(i for i in res["impacted"] if i["name"] == "run_job")
    assert hit["hop"] == 1 and hit["path"][-1]["type"] == "DISPATCH"
    assert hit["path"][-1]["via"] == "shop/service.py::Job.run"


def test_base_contract_changes_reach_overrides_but_body_changes_do_not(mini):
    body = T.impact_of(mini, ["Job.run"], "body")
    assert "ReportJob.run" not in names(body["impacted"])  # an override replaces the body it would inherit
    for change in ("signature", "rename"):
        o = next(i for i in T.impact_of(mini, ["Job.run"], change)["impacted"] if i["name"] == "ReportJob.run")
        assert o["path"][-1]["type"] == "OVERRIDES" and "overrid" in o["verdict"]


def test_override_arity_is_checked_against_the_new_base_signature(mini):
    from aftershock.analysis.impact import Seed, simulate
    from aftershock.graph import get_store

    g = get_store().repo(mini)
    res = simulate(g, [Seed("shop/service.py::Job.run", "signature", min_args=1, max_args=1)])
    o = next(i for i in res["impacted"] if i["name"] == "ReportJob.run")
    assert o["verdict"].startswith("override takes 0") and o["tier"] == "definite"
    ok = simulate(g, [Seed("shop/service.py::Job.run", "signature", min_args=0, max_args=0)])
    assert next(i for i in ok["impacted"] if i["name"] == "ReportJob.run")["verdict"].startswith("override still")


def test_culprit_reach_follows_dispatch_into_overrides(mini):
    from aftershock.analysis.culprit import _forward
    from aftershock.graph import get_store

    seen = _forward(get_store().repo(mini), ["shop/service.py::run_job"], 3)["shop/service.py::run_job"]
    assert seen["shop/service.py::ReportJob.run"][1]["type"] == "DISPATCH"


def test_body_change_is_lower_risk_than_delete(mini):
    body = T.impact_of(mini, ["connect"], "body")
    gone = T.impact_of(mini, ["connect"], "delete")
    assert gone["risk"]["score"] > body["risk"]["score"]
    assert {i["name"] for i in gone["impacted"]} >= {"load_user"}


def test_impact_crosses_into_typescript_and_jsx(mini):
    res = T.impact_of(mini, ["formatPrice"], "rename")
    assert names(res["impacted"]) == {"Price", "Page"}
    page = next(i for i in res["impacted"] if i["name"] == "Page")
    assert page["hop"] == 2


def test_impact_unknown_symbol_reports_problem(mini):
    res = T.impact_of(mini, ["definitely_not_here"], "body")
    assert res.get("error")


def test_explain_path_gives_hop_evidence(mini):
    res = T.explain_path(mini, "get_user", "connect")
    assert res["found"] and res["direction"] == "forward"
    hops = [(s["from"]["name"], s["to"]["name"], s["how"]) for s in res["steps"]]
    assert hops == [("get_user", "load_user", "module-attr"), ("load_user", "connect", "import")]
    assert 0 < res["confidence"] <= 1


def test_explain_path_finds_reverse_direction(mini):
    res = T.explain_path(mini, "connect", "get_user")
    assert res["found"] and res["direction"] == "reverse"


def test_explain_path_unrelated_symbols(mini):
    res = T.explain_path(mini, "health", "formatName")
    assert not res.get("found")


def test_select_tests(mini):
    res = T.select_tests(mini, ["load_user"])
    assert res["files"] == ["tests/test_api.py"]
    assert {t["name"] for t in res["tests"]} == {"test_get_user"}


def test_culprit_ranks_shared_code_first(mini):
    res = T.culprits(mini, ["test_get_user", "test_connect"])
    top = res["suspects"][0]
    # connect, Store and Store.__init__ are all reached by both tests (equal Ochiai); the nearest one ranks first
    assert top["name"] == "connect" and top["failed"] == 2 and top["hops"] == 1
    assert all(s["name"] != "health" for s in res["suspects"])


def test_dead_code_finds_unused_private_helper(mini):
    found = {c["name"] for c in T.dead_code(mini)["candidates"]}
    assert "_unused_helper" in found
    assert "connect" not in found and "load_user" not in found


def test_symbol_neighbourhood(mini):
    res = T.symbol(mini, "load_user")
    assert {c["name"] for c in res["callers"]} == {"get_user", "ReportJob.run"}
    assert {c["name"] for c in res["callees"]} >= {"connect"}


def test_overview_counts(mini):
    res = T.overview(mini)
    assert res["counts"]["files"] == 8  # incl. the empty shop/__init__.py
    assert res["counts"]["calls"] >= 9


def test_receipts_are_attached(mini):
    res = T.run(T.impact_of, mini, ["connect"], "body")
    assert res["receipts"]["queries"] > 0
    assert res["receipts"]["total_ms"] >= res["receipts"]["graph_ms"] >= 0


def test_markdown_report(mini):
    res = T.impact_of(mini, ["connect"], "signature", markdown=True)
    md = res["markdown"]
    assert md.startswith("<!-- aftershock:report -->")
    assert "`load_user`" in md and "test_get_user" not in md.split("Tests to run")[0].split("Likely to break")[0]
    assert "tests/test_api.py" in md


def test_cypher_guard(mini):
    assert T.cypher(mini, "MATCH (s:Symbol) RETURN count(s) AS n")["rows"][0]["n"] > 0
    for bad in ("MATCH (s:Symbol) DELETE s", "CREATE (:X)", "MATCH (s) SET s.x = 1",
                "MATCH p=(a)-[*]->(b) RETURN p", "CALL db.idx.fulltext.drop('x')"):
        try:
            T.cypher(mini, bad)
        except T.ToolError:
            continue
        raise AssertionError(f"accepted: {bad}")


def test_unknown_repo_and_bad_names():
    for bad in ("nosuch-repo-xyz", "../etc", "a b"):
        try:
            T.impact_of(bad, ["x"])
        except T.ToolError:
            continue
        raise AssertionError(bad)
