"""Which files in a working tree are source we should index. Read-only: never runs anything from the repo itself."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from .parse import lang_for

SKIP_DIRS = {
    ".git", "node_modules", ".venv", "venv", "env", "__pycache__", "dist", "build", "target", ".next", ".nuxt",
    "vendor", "third_party", "coverage", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", "site-packages",
    ".idea", ".vscode", "out", ".turbo", ".cache", "bower_components", ".gradle", ".terraform",
}
SKIP_SUFFIXES = (".min.js", ".bundle.js", ".d.ts.map", "_pb2.py", "_pb2_grpc.py", ".pb.go", ".generated.ts", ".gen.go")
CONFIG_FILES = ("go.mod", "tsconfig.json", "jsconfig.json", "web/tsconfig.json", "frontend/tsconfig.json", "app/tsconfig.json")
MAX_FILES = 50_000


def is_git(root: Path) -> bool:
    return (root / ".git").exists()


def list_sources(root: Path) -> list[str]:
    """Repo-relative POSIX paths of indexable source files, sorted. Honors .gitignore when the tree is a git repo."""
    paths: list[str] = []
    if is_git(root):
        try:
            out = subprocess.run(
                ["git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                capture_output=True, timeout=60, check=True,
            ).stdout
            paths = [p for p in out.decode("utf-8", "replace").split("\0") if p]
        except (subprocess.SubprocessError, OSError):
            paths = []
    if not paths:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
            rel = os.path.relpath(dirpath, root)
            for fn in filenames:
                paths.append(fn if rel == "." else f"{rel}/{fn}".replace(os.sep, "/"))
    keep = []
    for p in paths:
        parts = p.split("/")
        if any(d in SKIP_DIRS for d in parts[:-1]) or p.endswith(SKIP_SUFFIXES) or lang_for(p) is None:
            continue
        full = root / p
        if full.is_symlink() or not full.is_file():  # a symlink could point outside the allowed root
            continue
        keep.append(p)
    return sorted(keep)[:MAX_FILES]


LIB_PREFIX = "@lib/"  # graph paths of test-library files: `@lib/<library>/<path inside it>`


def libraries(repo_props: dict) -> dict[str, str]:
    """{library name: absolute directory} registered on the repo (`aftershock library add`)."""
    try:
        libs = json.loads(repo_props.get("libraries") or "{}")
    except ValueError:
        return {}
    return {k: v for k, v in libs.items() if isinstance(k, str) and isinstance(v, str)}


def library_sources(libs: dict[str, str]) -> dict[str, Path]:
    """{graph path: file on disk} for the Python files of every registered test library that is still on disk."""
    out: dict[str, Path] = {}
    for name, d in sorted(libs.items()):
        base = Path(d)
        if base.is_dir():
            out.update({f"{LIB_PREFIX}{name}/{p}": base / p for p in list_sources(base) if p.endswith(".py")})
    return out


def library_dirs(libs: dict[str, str]) -> dict[str, str]:
    """{absolute directory: graph path prefix}, to map pytest's view of a library file back to the graph."""
    return {str(Path(d).resolve()): f"{LIB_PREFIX}{name}/" for name, d in libs.items()}


def read_configs(root: Path) -> dict[str, bytes]:
    out = {}
    for name in CONFIG_FILES:
        p = root / name
        if p.is_file() and not p.is_symlink() and p.stat().st_size < 1_000_000:
            out[name] = p.read_bytes()
    return out
