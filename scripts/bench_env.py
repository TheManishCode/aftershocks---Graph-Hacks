"""Prepare a benchmark repo from bench/repos.toml: clone it if missing, check out the pinned commit, and build
.aftershock/envs/<name> (a uv venv with the repo and its test deps) for `aftershock coverage|run|mutate`.

    python scripts/bench_env.py click            # env only
    python scripts/bench_env.py click --index    # also index it into the graph as a lab repo

Needs `uv` and `git` on PATH. Installing a repo runs its build backend: only use repos you trust.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
MANIFEST = HERE / "bench" / "repos.toml"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("name")
    p.add_argument("--index", action="store_true", help="index into the graph and mark it lab")
    p.add_argument("--recreate", action="store_true", help="delete and rebuild the env")
    a = p.parse_args(argv)
    bench = tomllib.loads(MANIFEST.read_text(encoding="utf-8"))
    if a.name not in bench:
        print(f"unknown repo {a.name!r}; known: {', '.join(bench)}", file=sys.stderr)
        return 2
    spec = bench[a.name]
    if spec.get("status") != "ready":
        print(f"{a.name} is {spec.get('status')}: {spec.get('notes', '')}", file=sys.stderr)
        return 2
    for tool in ("uv", "git"):
        if not shutil.which(tool):
            print(f"{tool} is not on PATH", file=sys.stderr)
            return 2
    root = (MANIFEST.parent / spec["path"]).resolve()
    if not root.exists():
        subprocess.run(["git", "clone", "--quiet", spec["url"], str(root)], check=True)
    head = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True,
                          check=True).stdout.strip()
    if head != spec["commit"]:
        dirty = subprocess.run(["git", "-C", str(root), "status", "--porcelain"], capture_output=True, text=True,
                               check=True).stdout.strip()
        if dirty:
            print(f"{root} has local changes and is not at {spec['commit'][:10]}; leaving it alone", file=sys.stderr)
            return 2
        subprocess.run(["git", "-C", str(root), "fetch", "--quiet", "origin", spec["commit"]], check=False)
        subprocess.run(["git", "-C", str(root), "checkout", "--quiet", "--detach", spec["commit"]], check=True)
    env = HERE / ".aftershock" / "envs" / a.name
    if a.recreate and env.exists():
        shutil.rmtree(env)
    if not (env / "bin" / "python").exists():
        subprocess.run(["uv", "venv", "--quiet", "-p", spec.get("python", "3.12"), str(env)], check=True)
    install = [arg.replace("{root}", str(root)) for arg in spec["install"]]
    subprocess.run(["uv", "pip", "install", "--quiet", "--python", str(env / "bin" / "python"), *install], check=True)
    print(f"{a.name}: {root} @ {spec['commit'][:10]}, env {env}")
    if a.index:
        aft = [sys.executable, "-m", "aftershock.cli"]
        subprocess.run([*aft, "index", str(root), "--name", a.name], check=True, cwd=HERE)
        subprocess.run([*aft, "lab", a.name], check=True, cwd=HERE)
    busy = [port for port in spec.get("requires_free_ports", []) if _listening(port)]
    if busy:
        print(f"warning: its tests need port(s) {busy} free, and something listens there now", file=sys.stderr)
    print(f"next: aftershock coverage {a.name} && aftershock mutate {a.name} --n 30")
    return 0


def _listening(port: int) -> bool:
    import socket

    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


if __name__ == "__main__":
    sys.exit(main())
