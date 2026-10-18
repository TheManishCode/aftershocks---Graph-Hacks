"""What git history says about the indexed files: churn, owners, and logical coupling (files that change together).

Co-change follows CodeScene's "change coupling": two files are coupled when they share commits often relative to how
often each changes. Bulk commits (formatting sweeps, vendoring, renames) say nothing about coupling and are skipped.
Only `git log` is run; nothing from the repository is executed.
"""

from __future__ import annotations

import subprocess
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from itertools import combinations
from pathlib import Path

BULK_COMMIT = 30  # a commit touching more files than this is a sweep, not a signal of coupling
MIN_SHARED = 3  # co-changes needed before a pair counts
MIN_STRENGTH = 0.3
MAX_PAIRS_PER_FILE = 12
SEP = "\x1e"


@dataclass(slots=True)
class FileHistory:
    commits: int = 0
    churn: int = 0  # lines added + deleted
    last: int = 0  # unix time of the latest commit touching it
    authors: Counter = field(default_factory=Counter)


@dataclass(slots=True)
class History:
    head: str = ""
    commits: int = 0
    files: dict[str, FileHistory] = field(default_factory=dict)
    couples: list[tuple[str, str, int, float]] = field(default_factory=list)  # a, b, shared commits, strength
    people: dict[str, str] = field(default_factory=dict)  # email -> name
    last_by: dict[tuple[str, str], int] = field(default_factory=dict)  # (email, path) -> last commit time


def head_commit(root: Path) -> str:
    try:
        return subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10, check=True
        ).stdout.strip()
    except (subprocess.SubprocessError, OSError):
        return ""


def mine(root: Path, keep: set[str], max_commits: int = 2000) -> History:
    h = History(head=head_commit(root))
    if not h.head:
        return h
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "log", f"-n{max_commits}", "--no-merges", "--no-renames", "--numstat",
             f"--format={SEP}%H%x00%at%x00%aE%x00%aN"],
            capture_output=True, timeout=120, check=True,
        ).stdout.decode("utf-8", "replace")
    except (subprocess.SubprocessError, OSError):
        return h
    pair_counts: Counter = Counter()
    for block in out.split(SEP)[1:]:
        lines = block.strip("\n").split("\n")
        head = lines[0].split("\0")
        if len(head) < 4:
            continue
        _, ts, email, name = head[:4]
        email = email.strip().lower() or name
        ts = int(ts or 0)
        touched = []
        for ln in lines[1:]:
            parts = ln.split("\t")
            if len(parts) != 3 or parts[2] not in keep:
                continue
            added, deleted, path = parts
            fh = h.files.setdefault(path, FileHistory())
            fh.commits += 1
            fh.churn += (int(added) if added.isdigit() else 0) + (int(deleted) if deleted.isdigit() else 0)
            fh.last = max(fh.last, ts)
            fh.authors[email] += 1
            h.people.setdefault(email, name)
            h.last_by[(email, path)] = max(h.last_by.get((email, path), 0), ts)
            touched.append(path)
        h.commits += 1
        if 2 <= len(touched) <= BULK_COMMIT:
            for a, b in combinations(sorted(set(touched)), 2):
                pair_counts[(a, b)] += 1
    per_file: dict[str, list] = defaultdict(list)
    for (a, b), n in pair_counts.items():
        if n < MIN_SHARED:
            continue
        strength = n / ((h.files[a].commits + h.files[b].commits) / 2)
        if strength >= MIN_STRENGTH:
            per_file[a].append((strength, n, b))
            per_file[b].append((strength, n, a))
    seen = set()
    for a, lst in per_file.items():
        for strength, n, b in sorted(lst, reverse=True)[:MAX_PAIRS_PER_FILE]:
            key = (min(a, b), max(a, b))
            if key not in seen:
                seen.add(key)
                h.couples.append((key[0], key[1], n, round(min(strength, 1.0), 3)))
    return h
