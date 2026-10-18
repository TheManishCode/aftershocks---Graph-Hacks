"""Render an impact (or diff) result as a Markdown PR comment. Pure function of the JSON; no graph access."""

from __future__ import annotations

MARKER = "<!-- aftershock:report -->"
LEVEL_ICON = {"critical": "🔴", "high": "🟠", "medium": "🟡", "low": "🟢"}
CHANGE_LABEL = {"delete": "deleted", "rename": "renamed", "signature": "signature changed", "body": "body changed",
                "added": "added"}


def _loc(file: str | None, line: int | None, link: str | None) -> str:
    text = f"{file}:{line}" if line else (file or "?")
    return f"[`{text}`]({link}/{file}#L{line})" if link and file and line else f"`{text}`"


def _esc(s: str) -> str:
    return (s or "").replace("|", "\\|").replace("\n", " ")


def _why(row: dict) -> str:
    """The evidence for one impacted symbol: the hop chain, with the verdict on the step that decided it."""
    steps = row.get("path") or []
    if not steps:
        return ""
    shown = steps[-3:]
    parts = ["…" if len(steps) > 3 else f"`{shown[0]['from'].split('::')[-1]}`"]
    for st in shown:
        how = f"{(st.get('type') or 'CALLS').lower()}·{st.get('how') or '?'}"
        parts.append(f"`{_esc(st.get('label') or st['to'].split('::')[-1])}` <sub>{how}</sub>")
    verdict = f" — **{_esc(row['verdict'])}**" if row.get("verdict") else ""
    return " ← ".join(parts) + verdict


def render(result: dict, *, changes: dict | None = None, link: str | None = None, limit: int = 15) -> str:
    """`result` is impact.simulate output; `changes` an optional diff ChangeSet dict; `link` a blob URL prefix."""
    if not result or result.get("error"):
        body = result.get("error") if result else "No symbol-level changes detected against the indexed graph."
        return f"{MARKER}\n### Aftershock\n\n{body}\n"
    risk, counts = result["risk"], result["counts"]
    out = [MARKER, f"### {LEVEL_ICON.get(risk['level'], '')} Aftershock — {risk['level']} risk ({risk['score']}/100)", ""]
    out.append(f"**{counts['impacted']}** symbols in **{counts['files']}** files potentially impacted · "
               f"{counts['definite']} definite · {counts['likely']} likely · {counts['possible']} possible · "
               f"**{counts['tests']}** tests reach the change")
    out.append("")

    if changes:
        syms = [c for c in changes.get("symbols", []) if c["change"] != "added"]
        added = len(changes.get("symbols", [])) - len(syms)
        out.append(f"<details><summary><b>Changes</b> ({len(syms)} modified · {added} added · "
                   f"{len(changes.get('files_changed', []))} files)</summary>\n")
        out.append("| Symbol | Change | Location |")
        out.append("|---|---|---|")
        for c in syms[:40]:
            what = CHANGE_LABEL.get(c["change"], c["change"])
            if c.get("renamed_to"):
                what += f" → `{c['renamed_to'].split('::')[-1]}`"
            if c["change"] == "signature" and c.get("new_signature"):
                what += f"<br><code>{_esc(c['new_signature'])[:160]}</code>"
            out.append(f"| `{_esc(c['qname'])}` | {what} | {_loc(c['file'], c.get('line'), link)} |")
        out.append("\n</details>\n")
    else:
        out.append("**Changed:** " + ", ".join(f"`{s['name']}` ({CHANGE_LABEL.get(s['change'], s['change'])})"
                                               for s in result["seeds"][:10]))
        out.append("")

    breaking = [r for r in result["impacted"] if r["tier"] in ("definite", "likely")]
    if breaking:
        out.append("#### Likely to break")
        out.append("| | Symbol | Location | Why |")
        out.append("|---|---|---|---|")
        for r in breaking[:limit]:
            dot = "●" if r["tier"] == "definite" else "◐"
            out.append(f"| {dot} {round(r['p'] * 100)}% | `{_esc(r['name'])}` | {_loc(r['file'], r.get('line'), link)} "
                       f"| {_why(r)} |")
        if len(breaking) > limit:
            out.append(f"\n…and {len(breaking) - limit} more.")
        out.append("")

    if result["untested_seeds"]:
        out.append("#### ⚠ Changed with no test reaching it")
        out.append(", ".join(f"`{s['name']}`" for s in result["untested_seeds"][:12]))
        out.append("")

    if result["tests"]:
        files = sorted({t["file"] for t in result["tests"]})
        out.append(f"<details><summary><b>Tests to run</b> ({len(result['tests'])} in {len(files)} files)</summary>\n")
        out.append("```")
        out += files[:60]
        out.append("```\n</details>\n")

    if result["hidden_coupling"]:
        out.append("#### Hidden coupling")
        out.append("No static edge, but these files historically change together with the ones you touched:")
        for h in result["hidden_coupling"][:6]:
            out.append(f"- `{h['path']}` — co-changed {h['count']}× (strength {h['strength']:.2f}) with "
                       + ", ".join(f"`{v}`" for v in h["via"][:3]))
        out.append("")

    if result.get("import_only"):
        rows = result["import_only"]
        out.append(f"<details><summary><b>Import-only dependents</b> ({len(rows)}): import a changed file, "
                   "no resolved call to the change</summary>\n")
        for r in rows[:20]:
            names = f" ({', '.join(r['names'][:4])})" if r.get("names") else ""
            out.append(f"- `{r['file']}` imports `{r['imports']}`{names}")
        out.append("\n</details>\n")

    if result["owners"]:
        out.append("**Suggested reviewers:** " + ", ".join(
            f"{o['name'] or o['email']} ({int(o['commits'])} commits)" for o in result["owners"][:4]))
        out.append("")

    comp = risk["components"]
    out.append(f"<sub>Expected breakages {comp['expected_breakages']} · seed centrality {comp['seed_centrality']} · "
               f"{result['hops']} hops{' (truncated)' if result.get('truncated') else ''}. {result['note']}</sub>")
    return "\n".join(out) + "\n"
