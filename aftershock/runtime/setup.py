"""Make a repo runnable (D29): give it a test interpreter with its own dependencies, and install the tools the script
library needs. Everything installed comes from a fixed recipe below or from the repo's own manifests, never from a
name the caller types, so the run gate (D18/D29) is the only thing standing between a visitor and an install.

Python tools go into the repo's interpreter (its `.venv`, or the env Aftershock created under AFTERSHOCK_ENV_DIR),
Node tools into one shared prefix under the cache dir. Tools that need a system package manager are reported with
the command to run instead: installing those is the operator's call.
"""

from __future__ import annotations

import contextlib
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import tomllib
from dataclasses import dataclass
from pathlib import Path

from ..config import get_settings
from .pytest_run import RuntimeErrorReport, child_env, python_for


@dataclass(frozen=True)
class Recipe:
    method: str  # pip | npm | manual
    package: str = ""
    hint: str = ""

    def as_dict(self) -> dict:
        return {"method": self.method, "package": self.package, "hint": self.hint}


def _pip(pkg: str) -> Recipe:
    return Recipe("pip", pkg)


def _npm(pkg: str) -> Recipe:
    return Recipe("npm", pkg)


def _manual(hint: str) -> Recipe:
    return Recipe("manual", hint=hint)


# Keyed by `Script.tool`. pytest and the stdlib-only scripts need the test environment rather than a tool.
RECIPES: dict[str, Recipe] = {
    **{t: _pip(t) for t in ("bandit", "black", "build", "flake8", "interrogate", "isort", "mypy", "pyflakes",
                            "pylint", "radon", "vulture", "ruff", "safety", "tox", "nox", "pyright", "codespell",
                            "yamllint", "pre-commit", "semgrep", "coverage", "pytest", "pip")},
    "pip_audit": _pip("pip-audit"),
    **{t: _npm(t) for t in ("eslint", "depcheck", "jest", "knip", "mocha", "prettier", "vitest",
                            "markdownlint-cli2")},
    "biome": _npm("@biomejs/biome"),
    "tsc": _npm("typescript"),
    "playwright": _npm("@playwright/test"),
    "shellcheck": _manual("apt install shellcheck  ·  brew install shellcheck"),
    "hadolint": _manual("brew install hadolint  ·  or the release binary from github.com/hadolint/hadolint"),
    "gitleaks": _manual("brew install gitleaks  ·  go install github.com/zricethezav/gitleaks/v8@latest"),
    "trufflehog": _manual("brew install trufflehog"),
    "osv-scanner": _manual("go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest"),
    "typos": _manual("cargo install typos-cli  ·  brew install typos-cli"),
    "actionlint": _manual("go install github.com/rhysd/actionlint/cmd/actionlint@latest"),
    "zizmor": _pip("zizmor"),
    "golangci-lint": _manual("brew install golangci-lint"),
    "govulncheck": _manual("go install golang.org/x/vuln/cmd/govulncheck@latest"),
    "staticcheck": _manual("go install honnef.co/go/tools/cmd/staticcheck@latest"),
    "cargo-audit": _manual("cargo install cargo-audit"),
    "cargo-clippy": _manual("rustup component add clippy"),
    "cargo-fmt": _manual("rustup component add rustfmt"),
    **{t: _manual(f"install {t} with your system package manager")
       for t in ("go", "gofmt", "cargo", "npm", "node", "bash", "docker", "dotnet", "mvn", "bundle", "php", "make",
                 "just")},
}
TEST_EXTRAS = ("test", "tests", "testing", "dev")
MAX_TOOLS = 20
TAIL = 6000


def node_prefix() -> Path:
    return get_settings().cache_dir / "tools" / "node"


def node_bin() -> Path:
    return node_prefix() / "node_modules" / ".bin"


def recipe_for(tool: str | None) -> Recipe | None:
    return RECIPES.get(tool) if tool else None


def interpreter(root: Path, repo: str) -> str | None:
    try:
        return python_for(root, repo)
    except RuntimeErrorReport:
        return None


def _env() -> dict[str, str]:
    env = child_env()
    env.update({"PIP_DISABLE_PIP_VERSION_CHECK": "1", "PIP_NO_INPUT": "1", "PIP_PROGRESS_BAR": "off",
                "npm_config_update_notifier": "false", "npm_config_fund": "false", "npm_config_audit": "false",
                "NO_COLOR": "1"})
    return env


def _stream(argv: list[str], cwd: Path, emit, cancel: threading.Event | None, deadline: float) -> tuple[int, str]:
    """Run one install step, emitting its output line by line. Returns (exit code, output tail)."""
    emit("output", {"line": "$ " + " ".join(argv)})
    p = subprocess.Popen(argv, cwd=cwd, env=_env(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                         errors="replace", start_new_session=True)
    tail: list[str] = []
    killer = threading.Thread(target=_watch, args=(p, cancel, deadline), daemon=True)
    killer.start()
    assert p.stdout is not None
    for line in p.stdout:
        line = line.rstrip()
        if line:
            tail.append(line)
            emit("output", {"line": line[:400]})
    rc = p.wait()
    out = "\n".join(tail)[-TAIL:]
    if time.monotonic() >= deadline:
        raise RuntimeErrorReport(f"install timed out\n{out}")
    if cancel is not None and cancel.is_set():
        raise RuntimeErrorReport("install stopped")
    return rc, out


def _watch(p: subprocess.Popen, cancel: threading.Event | None, deadline: float) -> None:
    while p.poll() is None:
        if time.monotonic() >= deadline or (cancel is not None and cancel.is_set()):
            with contextlib.suppress(ProcessLookupError):
                os.killpg(p.pid, signal.SIGKILL)
            return
        time.sleep(0.2)


def test_requirements(root: Path) -> dict:
    """What the repo says it needs for its tests: extras, dependency groups (PEP 735) and requirements files."""
    out: dict = {"installable": False, "extras": [], "groups": [], "files": []}
    meta = root / "pyproject.toml"
    data: dict = {}
    if meta.is_file():
        try:
            data = tomllib.loads(meta.read_text())
        except (tomllib.TOMLDecodeError, OSError, UnicodeDecodeError):
            data = {}
    if (data.get("build-system") or (root / "setup.py").is_file() or (root / "setup.cfg").is_file()
            or isinstance(data.get("project"), dict)):
        out["installable"] = True
    extras = (data.get("project") or {}).get("optional-dependencies") or {}
    out["extras"] = [k for k in TEST_EXTRAS if k in extras]
    groups = data.get("dependency-groups") or {}
    out["groups"] = [k for k in TEST_EXTRAS if k in groups]
    cands = sorted(root.glob("requirements*.txt")) + sorted(root.glob("requirements/*.txt"))
    for f in cands:
        name = f.name.lower()
        if f.is_file() and f.resolve().is_relative_to(root.resolve()) and (
                f.parent == root or any(w in name for w in ("test", "dev"))):
            out["files"].append(f.relative_to(root).as_posix())
    return out


def setup_env(repo: str, root: Path, emit=None, cancel: threading.Event | None = None, timeout: int = 900) -> dict:
    """Create the repo's test interpreter when it has none, then install the repo, its test requirements, pytest
    and coverage into it. The repo's own `.venv` is used as is. Streams `step` and `output`."""
    emit = emit or (lambda kind, data: None)
    deadline = time.monotonic() + timeout
    steps: list[dict] = []

    def step(name: str, argv: list[str], cwd: Path = root, required: bool = True) -> None:
        emit("step", {"name": name, "status": "running"})
        rc, out = _stream(argv, cwd, emit, cancel, deadline)
        ok = rc == 0
        steps.append({"name": name, "ok": ok})
        emit("step", {"name": name, "status": "done" if ok else "failed"})
        if not ok and required:
            raise RuntimeErrorReport(f"{name} failed (exit {rc})\n{out[-2000:]}")

    python = interpreter(root, repo)
    created = False
    if python is None:
        env = get_settings().env_dir.resolve() / repo
        env.parent.mkdir(parents=True, exist_ok=True)
        step("create environment", [sys.executable, "-m", "venv", "--clear", str(env)], cwd=env.parent)
        python, created = str(env / "bin" / "python"), True
    reqs = test_requirements(root)
    step("update pip", [python, "-m", "pip", "install", "-q", "-U", "pip"], required=False)
    if reqs["installable"]:
        target = "." + (f"[{','.join(reqs['extras'])}]" if reqs["extras"] else "")
        step("install the repo", [python, "-m", "pip", "install", "-e", target])
    for g in reqs["groups"]:
        # pip >= 25.1; an older pip fails the step, which is reported and not fatal
        step(f"dependency group {g}", [python, "-m", "pip", "install", "--group", g], required=False)
    for f in reqs["files"]:
        step(f"requirements {f}", [python, "-m", "pip", "install", "-r", f], required=False)
    step("install pytest and coverage", [python, "-m", "pip", "install", "pytest", "coverage"])
    return {"created": created, "requirements": reqs, "steps": steps,
            "failed": [s["name"] for s in steps if not s["ok"]]}


def install_tools(repo: str, root: Path, tools: list[str], emit=None, cancel: threading.Event | None = None,
                  timeout: int = 900) -> dict:
    """Install `tools` by their recipes. Unknown names are refused before anything runs; `manual` ones come back
    with the command for the operator."""
    emit = emit or (lambda kind, data: None)
    if not tools or len(tools) > MAX_TOOLS:
        raise RuntimeErrorReport(f"pick 1 to {MAX_TOOLS} tools")
    unknown = [t for t in tools if t not in RECIPES]
    if unknown:
        raise RuntimeErrorReport(f"no install recipe for {', '.join(sorted(unknown))}")
    deadline = time.monotonic() + timeout
    by = {m: sorted({RECIPES[t].package for t in tools if RECIPES[t].method == m}) for m in ("pip", "npm")}
    results: dict[str, dict] = {}
    for t in tools:
        if RECIPES[t].method == "manual":
            results[t] = {"status": "manual", "hint": RECIPES[t].hint}
    if by["pip"]:
        python = interpreter(root, repo)
        if python is None:
            for t in tools:
                if RECIPES[t].method == "pip":
                    results[t] = {"status": "needs-setup", "hint": "set up the test environment first"}
        else:
            emit("step", {"name": "pip install " + " ".join(by["pip"]), "status": "running"})
            rc, out = _stream([python, "-m", "pip", "install", *by["pip"]], root, emit, cancel, deadline)
            for t in tools:
                if RECIPES[t].method == "pip":
                    results[t] = {"status": "installed" if rc == 0 else "failed"}
    if by["npm"]:
        npm = shutil.which("npm")
        if npm is None:
            for t in tools:
                if RECIPES[t].method == "npm":
                    results[t] = {"status": "manual", "hint": "Node.js and npm are not installed on this server"}
        else:
            node_prefix().mkdir(parents=True, exist_ok=True)
            emit("step", {"name": "npm install " + " ".join(by["npm"]), "status": "running"})
            # --ignore-scripts: these packages need no install hooks, and none should run on the API's host
            rc, out = _stream([npm, "install", "--prefix", str(node_prefix()), "--ignore-scripts",
                               *by["npm"]], node_prefix(), emit, cancel, deadline)
            for t in tools:
                if RECIPES[t].method == "npm":
                    results[t] = {"status": "installed" if rc == 0 else "failed"}
    counts = {k: sum(r["status"] == k for r in results.values())
              for k in ("installed", "failed", "manual", "needs-setup")}
    return {"tools": results, **counts}
