"""Smoke probes run in the *target* repo's interpreter (stdlib only), by the script library (catalog/probes.py).

    python _aftershock_smoke.py imports ROOT   import every module of the repo's packages, one line per failure
    python _aftershock_smoke.py cli ROOT       resolve each declared console script and run it with --help

Failures print as `path:line: message` so the caller can attach them to files.
"""

import importlib
import os
import subprocess
import sys
import traceback
from pathlib import Path

SKIP = {".git", ".venv", "venv", "env", "node_modules", "__pycache__", "build", "dist", ".tox", ".nox", "docs",
        "examples", "tests", "test", "testing", "benchmarks", "scripts", ".aftershock"}


def _where(root: Path, exc: BaseException, fallback: str) -> str:
    """The deepest frame inside the repo, else the module's own file."""
    tb = traceback.extract_tb(exc.__traceback__)
    for fr in reversed(tb):
        try:
            rel = Path(fr.filename).resolve().relative_to(root)
        except ValueError:
            continue
        return f"{rel.as_posix()}:{fr.lineno}"
    if isinstance(exc, SyntaxError) and exc.filename:
        try:
            return f"{Path(exc.filename).resolve().relative_to(root).as_posix()}:{exc.lineno or 1}"
        except ValueError:
            pass
    return f"{fallback}:1"


def _packages(root: Path):
    """(import base, package dir) for top-level packages in the root and in src/."""
    for base in (root / "src", root):
        if not base.is_dir():
            continue
        for d in sorted(base.iterdir()):
            if d.is_dir() and d.name not in SKIP and not d.name.startswith(".") and (d / "__init__.py").is_file():
                yield base, d


def imports(root: Path) -> int:
    bases, mods = [], []
    for base, pkg in _packages(root):
        if str(base) not in bases:
            bases.append(str(base))
        for dirpath, dirs, files in os.walk(pkg):
            dirs[:] = sorted(d for d in dirs if d not in SKIP and not d.startswith(".")
                             and (Path(dirpath, d) / "__init__.py").is_file())
            for f in sorted(files):
                if f.endswith(".py") and f != "__main__.py" and not f.startswith("test_"):
                    rel = Path(dirpath, f).relative_to(base).with_suffix("")
                    parts = rel.parts[:-1] if rel.name == "__init__" else rel.parts
                    mods.append((".".join(parts), Path(dirpath, f).relative_to(root).as_posix()))
    if not mods:
        print("no importable packages found (a directory with __init__.py at the root or under src/)")
        return 0
    sys.path[:0] = bases
    bad = 0
    for name, path in mods[:2000]:
        try:
            importlib.import_module(name)
        except BaseException as e:  # noqa: BLE001 -- SystemExit and KeyboardInterrupt from import time count too
            if isinstance(e, KeyboardInterrupt):
                raise
            bad += 1
            msg = (str(e).strip().splitlines() or [""])[0][:300]
            print(f"{_where(root, e, path)}: {type(e).__name__} importing {name}: {msg}")
    print(f"imported {len(mods) - bad} of {len(mods)} modules; {bad} failed")
    return 1 if bad else 0


def _entry_points(root: Path):
    meta = root / "pyproject.toml"
    if meta.is_file():
        try:
            import tomllib

            data = tomllib.loads(meta.read_text())
        except Exception:  # noqa: BLE001 -- Python < 3.11 or a broken file: fall back to setup.cfg
            data = {}
        text = meta.read_text().splitlines()
        for name, target in ((data.get("project") or {}).get("scripts") or {}).items():
            line = next((i for i, t in enumerate(text, 1) if t.strip().startswith((f"{name} ", f"{name}=",
                                                                                    f'"{name}"'))), 1)
            yield name, target, f"pyproject.toml:{line}"
    cfg = root / "setup.cfg"
    if cfg.is_file():
        import configparser

        cp = configparser.ConfigParser()
        try:
            cp.read(cfg)
            raw = cp.get("options.entry_points", "console_scripts", fallback="")
        except configparser.Error:
            raw = ""
        for ln in raw.strip().splitlines():
            if "=" in ln:
                name, target = (x.strip() for x in ln.split("=", 1))
                yield name, target, "setup.cfg:1"


def cli(root: Path) -> int:
    sys.path[:0] = [str(root / "src"), str(root)]
    found, bad = 0, 0
    bindir = Path(sys.executable).parent
    for name, target, where in _entry_points(root):
        found += 1
        mod, _, attr = target.partition(":")
        attr = attr.split("[")[0].strip()
        try:
            obj = importlib.import_module(mod.strip())
            for part in filter(None, attr.split(".")):
                obj = getattr(obj, part)
            if not callable(obj):
                raise TypeError(f"{target} is not callable")
        except BaseException as e:  # noqa: BLE001
            if isinstance(e, KeyboardInterrupt):
                raise
            bad += 1
            print(f"{where}: console script {name} -> {target} does not resolve: {type(e).__name__}: "
                  f"{(str(e).splitlines() or [''])[0][:200]}")
            continue
        exe = bindir / name
        if not exe.is_file():
            print(f"{name}: resolves, but is not installed in this interpreter (install the repo to try --help)")
            continue
        try:
            p = subprocess.run([str(exe), "--help"], capture_output=True, text=True, timeout=60, cwd=root,
                               stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            bad += 1
            print(f"{where}: {name} --help did not finish in 60s")
            continue
        if p.returncode != 0:
            bad += 1
            last = ((p.stderr or p.stdout).strip().splitlines() or [""])[-1][:300]
            print(f"{where}: {name} --help exited {p.returncode}: {last}")
        else:
            print(f"{name} --help ok")
    if not found:
        print("no console scripts declared ([project.scripts] or setup.cfg console_scripts)")
    print(f"{found} console scripts, {bad} broken")
    return 1 if bad else 0


if __name__ == "__main__":
    # this file's directory is Aftershock's runtime package (jobs.py, setup.py, ...): keep it off the import path
    here = Path(__file__).resolve().parent
    sys.path[:] = [p for p in sys.path if Path(p or ".").resolve() != here]
    mode, root = sys.argv[1], Path(sys.argv[2]).resolve()
    os.chdir(root)
    sys.exit({"imports": imports, "cli": cli}[mode](root))
