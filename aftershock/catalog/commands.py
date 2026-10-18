"""`command` scripts: real tools run as subprocesses in the checkout (no shell, scrubbed environment, timeout,
killed as a process group). They can execute repo code or config, so they only run behind the run gate.

A command applies when the repo has the files that tool works on, and is available when the tool is installed
(the repo's venv, node_modules/.bin, or PATH). Nothing is ever downloaded: no `pip install`, no bare `npx`.
"""

from __future__ import annotations

import re

from . import Ctx, Script, register
from .static import _is_test


def cmd(id_, name, cat, eco, summary, argv, applies, tool=None, severity="error", timeout=900, tags=()):
    return Script(id=id_, name=name, category=cat, ecosystem=eco, summary=summary, kind="command",
                  argv=tuple(argv), tool=tool, applies=applies, severity=severity, timeout=timeout, tags=tuple(tags))


def pytest_run(id_, name, summary, mode, tags=()):
    return Script(id=id_, name=name, category="tests", ecosystem="python", summary=summary, kind="command",
                  pytest_mode=mode, tool="pytest", applies=_pytests, severity="error", tags=tuple(tags))


def _py(c: Ctx) -> bool:
    return bool(c.ext(".py"))


def _pytests(c: Ctx) -> bool:
    return any(_is_test(f) for f in c.ext(".py"))


def _pyproject_tool(name: str):
    return lambda c: _py(c) and any(f"[tool.{name}" in (c.text(f) or "")
                                    for f in ("pyproject.toml", "setup.cfg", "tox.ini") if f in c.fileset)


def _node(c: Ctx) -> bool:
    return "package.json" in c.fileset


def _npm(script: str):
    return lambda c: _node(c) and c.npm_script(script)


def _dep(*names: str):
    return lambda c: _node(c) and any(c.node_dep(n) for n in names)


def _ts(c: Ctx) -> bool:
    return "tsconfig.json" in c.fileset


def _eslint(c: Ctx) -> bool:
    return _node(c) and (c.node_dep("eslint") or any(re.match(r"(\.eslintrc|eslint\.config)", f) for f in c.files
                                                     if "/" not in f))


def _go(c: Ctx) -> bool:
    return "go.mod" in c.fileset


def _rust(c: Ctx) -> bool:
    return "Cargo.toml" in c.fileset


def _sh(c: Ctx) -> bool:
    return bool(c.ext(".sh", ".bash"))


def _docker(c: Ctx) -> bool:
    return any(re.search(r"(^|/)(Dockerfile|Containerfile)([.-][\w.-]+)?$", f) for f in c.files)


def _gha(c: Ctx) -> bool:
    return any(f.startswith(".github/workflows/") for f in c.files)


def _make_target(target: str):
    return lambda c: any(re.search(rf"^{target}\s*:(?!=)", c.text(f) or "", re.MULTILINE)
                         for f in ("Makefile", "makefile", "GNUmakefile") if f in c.fileset)


def _dockerfiles(c: Ctx) -> list[str]:
    return [f for f in c.files if re.search(r"(^|/)(Dockerfile|Containerfile)([.-][\w.-]+)?$", f)]


def _any(*fs):
    return lambda c: any(f(c) for f in fs)


P, M = "{python}", "-m"
T = "{tool}"

register(
    # ---- python: tests ---------------------------------------------------------------------------------------
    pytest_run("pytest.diff", "Tests the working-tree change reaches",
               "Graph-selected tests for the uncommitted change, then culprit ranking on failure. Recorded.", "diff",
               tags=("impact", "fast")),
    pytest_run("pytest.all", "Full pytest suite", "Every test, recorded with culprits for any failure.", "all"),
    pytest_run("pytest.coverage", "Full suite with per-test coverage",
               "Every test under coverage; writes COVERS edges so selection becomes exact. Slower.", "coverage",
               tags=("coverage",)),
    cmd("pytest.collect", "pytest collection only", "tests", "python",
        "Collects tests without running them: import errors and broken fixtures show up in seconds.",
        (P, M, "pytest", "--collect-only", "-q", "-p", "no:cacheprovider"), _pytests, tool="pytest",
        tags=("fast",)),
    cmd("pytest.failfast", "pytest, stop at first failure", "tests", "python",
        "Runs the suite with -x --ff: previously failing tests first, stop on the first failure.",
        (P, M, "pytest", "-x", "--ff", "-q", "-rfE"), _pytests, tool="pytest", tags=("fast",)),
    cmd("pytest.durations", "Slowest tests", "tests", "python", "Full suite reporting the 25 slowest tests.",
        (P, M, "pytest", "-q", "--durations=25", "-p", "no:cacheprovider"), _pytests, tool="pytest",
        severity="warn", tags=("performance",)),
    cmd("pytest.doctest", "Doctests", "tests", "python", "Runs the >>> examples in docstrings.",
        (P, M, "pytest", "--doctest-modules", "-q", "-p", "no:cacheprovider", "--ignore=tests", "--ignore=test"),
        lambda c: _py(c) and any(">>> " in (c.text(f) or "") for f in c.ext(".py")[:2000] if not _is_test(f)),
        tool="pytest"),
    cmd("pytest.random-order", "Tests in reverse order", "tests", "python",
        "Runs the suite in reverse order (needs pytest-reverse installed): catches order-dependent tests.",
        (P, M, "pytest", "-q", "-p", "no:cacheprovider", "--reverse"),
        lambda c: _pytests(c) and c.has_module("pytest_reverse") is True, tool="pytest", tags=("flaky",)),
    cmd("py.unittest", "unittest discovery", "tests", "python",
        "python -m unittest discover, for suites that don't use pytest.",
        (P, M, "unittest", "discover", "-q"), lambda c: _pytests(c) and any(
            "unittest.TestCase" in (c.text(f) or "") for f in c.ext(".py") if _is_test(f)), tags=("legacy",)),
    cmd("py.tox", "tox", "tests", "python", "The tox environments the project defines (installs into .tox).",
        (T,), lambda c: "tox.ini" in c.fileset or _pyproject_tool("tox")(c), tool="tox", timeout=1800),
    cmd("py.nox", "nox", "tests", "python", "The nox sessions in noxfile.py.", (T,),
        lambda c: "noxfile.py" in c.fileset, tool="nox", timeout=1800),
    # ---- python: build -----------------------------------------------------------------------------------------
    cmd("py.compileall", "Byte-compile everything", "build", "python",
        "Compiles every module with the repo's own interpreter version (catches syntax the server's parser allows).",
        (P, M, "compileall", "-q", "-x", r"(^|/)(\.venv|venv|node_modules|\.git)/", "."), _py),
    cmd("py.pip-check", "pip check", "deps", "python", "Installed packages have compatible requirements.",
        (P, M, "pip", "check"), _py, tool="pip"),
    cmd("py.build", "Build sdist and wheel", "build", "python", "python -m build, the way PyPI would receive it.",
        (P, M, "build", "--outdir", ".aftershock/dist"), lambda c: "pyproject.toml" in c.fileset or "setup.py" in
        c.fileset, tool="build", timeout=1200),
    # ---- python: lint / format / types -------------------------------------------------------------------------
    cmd("py.ruff", "Ruff", "lint", "python", "ruff check with the project's configuration.",
        (T, "check", "--output-format=concise", "--no-cache", "."), _py, tool="ruff", tags=("fast",)),
    cmd("py.ruff-format", "Ruff format check", "lint", "python", "Files ruff format would change.",
        (T, "format", "--check", "--no-cache", "."), _py, tool="ruff", severity="warn", tags=("format",)),
    cmd("py.flake8", "Flake8", "lint", "python", "flake8 with the project's configuration.", (P, M, "flake8", "."),
        _py, tool="flake8"),
    cmd("py.pylint-errors", "Pylint (errors only)", "lint", "python", "pylint -E over the packages.",
        (P, M, "pylint", "-E", "--output-format=parseable", "--recursive=y", "."), _py, tool="pylint"),
    cmd("py.black", "Black check", "lint", "python", "Files black would reformat.", (P, M, "black", "--check", "."),
        _py, tool="black", severity="warn", tags=("format",)),
    cmd("py.isort", "isort check", "lint", "python", "Imports isort would reorder.",
        (P, M, "isort", "--check-only", "--diff", "."), _py, tool="isort", severity="warn", tags=("format",)),
    cmd("py.mypy", "mypy", "types", "python", "Static types with the project's mypy configuration.",
        (P, M, "mypy", "--no-error-summary", "--show-column-numbers", "--no-color-output", "."), _py, tool="mypy"),
    cmd("py.pyright", "Pyright", "types", "python", "Pyright / basedpyright type check.", (T,), _py,
        tool="pyright"),
    cmd("py.pyflakes", "Pyflakes", "lint", "python", "Undefined names and unused imports, nothing stylistic.",
        (P, M, "pyflakes", "."), _py, tool="pyflakes"),
    cmd("py.vulture", "Vulture", "lint", "python", "Unused code, by a second opinion to the graph.",
        (P, M, "vulture", ".", "--min-confidence", "80", "--exclude", ".venv,venv,node_modules"), _py,
        tool="vulture", severity="warn", tags=("cleanup",)),
    cmd("py.radon", "Radon complexity", "lint", "python", "Functions ranked C or worse by cyclomatic complexity.",
        (P, M, "radon", "cc", "-s", "-n", "C", "-e", ".venv/*,venv/*,node_modules/*", "."), _py, tool="radon",
        severity="info", tags=("complexity",)),
    cmd("py.interrogate", "Docstring coverage", "lint", "python", "interrogate's docstring coverage report.",
        (P, M, "interrogate", "-v", "."), _py, tool="interrogate", severity="info"),
    cmd("py.codespell", "Codespell", "lint", "generic", "Common misspellings in code and docs.", (T,),
        lambda c: True, tool="codespell", severity="warn"),
    # ---- python: security --------------------------------------------------------------------------------------
    cmd("py.bandit", "Bandit", "security", "python", "Bandit security lint over the source tree.",
        (P, M, "bandit", "-r", ".", "-q", "-f", "custom", "--msg-template", "{relpath}:{line}: {test_id} {msg}",
         "-x", "./.venv,./venv,./node_modules,./tests,./test"), _py, tool="bandit"),
    cmd("py.pip-audit", "pip-audit", "security", "python",
        "Installed packages checked against known vulnerabilities (queries the PyPI advisory database).",
        (P, M, "pip_audit", "--progress-spinner", "off"), _py, tool="pip_audit", tags=("network",)),
    cmd("py.safety", "Safety", "security", "python", "Dependency vulnerability scan with Safety.",
        (T, "check", "--bare"), _py, tool="safety", tags=("network",)),
    # ---- node --------------------------------------------------------------------------------------------------
    cmd("npm.test", "npm test", "tests", "node", "The project's own `test` script.", ("npm", "test", "--silent"),
        _npm("test"), tool="npm", timeout=1800),
    cmd("npm.lint", "npm run lint", "lint", "node", "The project's own `lint` script.",
        ("npm", "run", "lint", "--silent"), _npm("lint"), tool="npm"),
    cmd("npm.build", "npm run build", "build", "node", "The project's own `build` script.",
        ("npm", "run", "build", "--silent"), _npm("build"), tool="npm", timeout=1800),
    cmd("npm.typecheck", "npm run typecheck", "types", "node", "The project's own `typecheck` script.",
        ("npm", "run", "typecheck", "--silent"), _npm("typecheck"), tool="npm"),
    cmd("npm.format-check", "npm run format:check", "lint", "node", "The project's own `format:check` script.",
        ("npm", "run", "format:check", "--silent"), _npm("format:check"), tool="npm", severity="warn"),
    cmd("npm.audit", "npm audit", "security", "node",
        "Known vulnerabilities in the locked dependency tree (high and above; queries the npm registry).",
        ("npm", "audit", "--audit-level=high"), lambda c: "package-lock.json" in c.fileset, tool="npm",
        tags=("network",)),
    cmd("npm.ls", "npm ls", "deps", "node", "Installed tree matches package.json (missing / invalid / extraneous).",
        ("npm", "ls", "--all", "--silent"), lambda c: _node(c) and (c.root / "node_modules").is_dir(), tool="npm"),
    cmd("ts.tsc", "TypeScript compiler", "types", "node", "tsc --noEmit with the project's tsconfig.",
        (T, "--noEmit", "--pretty", "false"), _ts, tool="tsc"),
    cmd("js.eslint", "ESLint", "lint", "node", "eslint over the project with its own config.",
        (T, ".", "--format", "unix", "--max-warnings", "-1"), _eslint, tool="eslint"),
    cmd("js.prettier", "Prettier check", "lint", "node", "Files prettier would reformat.",
        (T, "--check", "."), _dep("prettier"), tool="prettier", severity="warn", tags=("format",)),
    cmd("js.biome", "Biome", "lint", "node", "biome check (lint + format).", (T, "check", "."),
        lambda c: _dep("@biomejs/biome")(c) or "biome.json" in c.fileset, tool="biome"),
    cmd("js.vitest", "Vitest", "tests", "node", "vitest run, once, no watch.", (T, "run"), _dep("vitest"),
        tool="vitest", timeout=1800),
    cmd("js.jest", "Jest", "tests", "node", "jest in CI mode.", (T, "--ci", "--passWithNoTests"), _dep("jest"),
        tool="jest", timeout=1800),
    cmd("js.mocha", "Mocha", "tests", "node", "mocha with the project's .mocharc.", (T,), _dep("mocha"),
        tool="mocha", timeout=1800),
    cmd("js.playwright-list", "Playwright test list", "tests", "node",
        "Lists the Playwright tests (does not launch browsers).", (T, "test", "--list"), _dep("@playwright/test"),
        tool="playwright", tags=("fast",)),
    cmd("js.knip", "Knip", "lint", "node", "Unused files, exports and dependencies.", (T, "--no-progress"),
        _dep("knip"), tool="knip", severity="warn", tags=("cleanup",)),
    cmd("js.depcheck", "depcheck", "deps", "node", "Dependencies declared but unused, or used but undeclared.",
        (T,), _dep("depcheck"), tool="depcheck", severity="warn"),
    cmd("js.node-check", "node --check", "build", "node", "Syntax-checks every plain .js/.mjs/.cjs file.",
        ("node", "--check", "{each:.js,.mjs,.cjs}"), lambda c: bool(c.ext(".js", ".mjs", ".cjs")), tool="node"),
    # ---- go ----------------------------------------------------------------------------------------------------
    cmd("go.build", "go build", "build", "go", "Builds every package.", ("go", "build", "./..."), _go, tool="go"),
    cmd("go.test", "go test", "tests", "go", "Every package's tests.", ("go", "test", "./..."), _go, tool="go",
        timeout=1800),
    cmd("go.test-race", "go test -race", "tests", "go", "Tests with the race detector.",
        ("go", "test", "-race", "./..."), _go, tool="go", timeout=1800, tags=("concurrency",)),
    cmd("go.vet", "go vet", "lint", "go", "Suspicious constructs the compiler accepts.", ("go", "vet", "./..."),
        _go, tool="go"),
    cmd("go.fmt", "gofmt", "lint", "go", "Files gofmt would change.", ("gofmt", "-l", "."), _go, tool="gofmt",
        severity="warn", tags=("format",)),
    cmd("go.mod-verify", "go mod verify", "deps", "go", "Downloaded modules match go.sum.",
        ("go", "mod", "verify"), _go, tool="go"),
    cmd("go.staticcheck", "staticcheck", "lint", "go", "staticcheck over every package.", (T, "./..."), _go,
        tool="staticcheck"),
    cmd("go.golangci", "golangci-lint", "lint", "go", "golangci-lint with the project's config.",
        (T, "run", "./..."), _go, tool="golangci-lint"),
    cmd("go.vulncheck", "govulncheck", "security", "go", "Known vulnerabilities in code paths actually called.",
        (T, "./..."), _go, tool="govulncheck", tags=("network",)),
    # ---- rust --------------------------------------------------------------------------------------------------
    cmd("rust.check", "cargo check", "build", "rust", "Type-checks the workspace.", ("cargo", "check", "--all"),
        _rust, tool="cargo", timeout=1800),
    cmd("rust.test", "cargo test", "tests", "rust", "Every crate's tests.", ("cargo", "test", "--all"), _rust,
        tool="cargo", timeout=1800),
    cmd("rust.clippy", "cargo clippy", "lint", "rust", "Clippy lints, warnings as errors.",
        ("cargo", "clippy", "--all-targets", "--", "-D", "warnings"), _rust, tool="cargo-clippy", timeout=1800),
    cmd("rust.fmt", "cargo fmt --check", "lint", "rust", "Files rustfmt would change.",
        ("cargo", "fmt", "--all", "--check"), _rust, tool="cargo-fmt", severity="warn", tags=("format",)),
    cmd("rust.audit", "cargo audit", "security", "rust", "Cargo.lock against the RustSec advisory database.",
        ("cargo", "audit"), lambda c: "Cargo.lock" in c.fileset, tool="cargo-audit", tags=("network",)),
    # ---- jvm / ruby / php / dotnet -----------------------------------------------------------------------------
    cmd("java.maven-test", "mvn test", "tests", "java", "Maven test phase, batch mode.",
        ("mvn", "-B", "-q", "test"), lambda c: "pom.xml" in c.fileset, tool="mvn", timeout=2400),
    cmd("java.gradle-test", "gradle test", "tests", "java", "The Gradle wrapper's test task.",
        ("./gradlew", "test", "--console=plain"), lambda c: "gradlew" in c.fileset, timeout=2400),
    cmd("ruby.rspec", "RSpec", "tests", "ruby", "bundle exec rspec.", ("bundle", "exec", "rspec"),
        lambda c: "Gemfile" in c.fileset and c.has(".rspec") or any(f.startswith("spec/") for f in c.files),
        tool="bundle", timeout=1800),
    cmd("ruby.rubocop", "RuboCop", "lint", "ruby", "bundle exec rubocop.", ("bundle", "exec", "rubocop",
                                                                            "--format", "emacs"),
        lambda c: "Gemfile" in c.fileset and "rubocop" in (c.text("Gemfile") or ""), tool="bundle"),
    cmd("php.phpunit", "PHPUnit", "tests", "php", "vendor/bin/phpunit.", ("vendor/bin/phpunit",),
        lambda c: c.has("phpunit.xml", "phpunit.xml.dist") and (c.root / "vendor/bin/phpunit").is_file(),
        timeout=1800),
    cmd("php.lint", "php -l", "build", "php", "Syntax-checks every .php file.", ("php", "-l", "{each:.php}"),
        lambda c: bool(c.ext(".php")), tool="php"),
    cmd("dotnet.test", "dotnet test", "tests", "dotnet", "dotnet test over the solution.", ("dotnet", "test"),
        lambda c: bool(c.ext(".sln", ".csproj", ".fsproj")), tool="dotnet", timeout=2400),
    cmd("dotnet.format", "dotnet format check", "lint", "dotnet", "Files dotnet format would change.",
        ("dotnet", "format", "--verify-no-changes"), lambda c: bool(c.ext(".sln", ".csproj")), tool="dotnet",
        severity="warn"),
    # ---- shell / docker / ci / generic -------------------------------------------------------------------------
    cmd("sh.syntax", "bash -n", "build", "shell", "Parses every shell script without running it.",
        ("bash", "-n", "{each:.sh,.bash}"), _sh, tool="bash"),
    cmd("sh.shellcheck", "ShellCheck", "lint", "shell", "shellcheck over every shell script.",
        (T, "-f", "gcc", "{each:.sh,.bash}"), _sh, tool="shellcheck"),
    cmd("docker.hadolint", "Hadolint", "lint", "docker", "Dockerfile best practices.",
        (T, "--format", "tty", "{dockerfiles}"), _docker, tool="hadolint"),
    cmd("docker.compose-config", "docker compose config", "config", "docker",
        "Compose files parse and resolve (variables, extends) without starting anything.",
        ("docker", "compose", "config", "--quiet"),
        lambda c: c.has("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"), tool="docker"),
    cmd("ci.actionlint", "actionlint", "config", "ci", "GitHub Actions workflow lint, including shell in run:.",
        (T, "-no-color"), _gha, tool="actionlint"),
    cmd("ci.zizmor", "zizmor", "security", "ci", "Security audit of GitHub Actions workflows.",
        (T, "--format", "plain", ".github/workflows"), _gha, tool="zizmor"),
    cmd("cfg.yamllint", "yamllint", "config", "generic", "yamllint with the project's config, or the default.",
        (T, "-f", "parsable", "."), lambda c: bool(c.ext(".yml", ".yaml")), tool="yamllint", severity="warn"),
    cmd("cfg.markdownlint", "markdownlint", "lint", "generic", "markdownlint-cli2 over the docs.",
        (T, "**/*.md", "#node_modules"), lambda c: bool(c.ext(".md")), tool="markdownlint-cli2", severity="warn"),
    cmd("cfg.typos", "typos", "lint", "generic", "Source-code spell checker.", (T, "--format", "brief"),
        lambda c: True, tool="typos", severity="warn"),
    cmd("sec.gitleaks", "Gitleaks", "security", "generic",
        "Secrets in the working tree (not history), with Gitleaks' ruleset. Matches are redacted.",
        (T, "dir", ".", "--redact", "--no-banner", "--no-color"), lambda c: True, tool="gitleaks"),
    cmd("sec.trufflehog", "TruffleHog", "security", "generic", "Verified-only secret scan of the working tree.",
        (T, "filesystem", ".", "--only-verified", "--no-update"), lambda c: True, tool="trufflehog",
        tags=("network",)),
    cmd("sec.semgrep", "Semgrep", "security", "generic",
        "semgrep with the project's .semgrep config (no registry download).", (T, "scan", "--config", ".semgrep",
                                                                                "--error", "--metrics=off"),
        lambda c: c.has(".semgrep.yml") or any(f.startswith(".semgrep/") for f in c.files), tool="semgrep"),
    cmd("sec.osv", "OSV-Scanner", "security", "generic", "Lockfiles against the OSV vulnerability database.",
        (T, "scan", "source", "-r", "."), lambda c: any(c.has(x) for x in (
            "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "uv.lock", "Cargo.lock", "go.sum",
            "Gemfile.lock", "requirements.txt")), tool="osv-scanner", tags=("network",)),
    cmd("repo.pre-commit", "pre-commit hooks", "lint", "generic",
        "Every hook in .pre-commit-config.yaml over all files (hooks already installed only).",
        (T, "run", "--all-files", "--show-diff-on-failure"), lambda c: ".pre-commit-config.yaml" in c.fileset,
        tool="pre-commit", timeout=1800),
    cmd("make.test", "make test", "tests", "generic", "The Makefile's test target.", ("make", "test"),
        _make_target("test"), tool="make", timeout=1800),
    cmd("make.lint", "make lint", "lint", "generic", "The Makefile's lint target.", ("make", "lint"),
        _make_target("lint"), tool="make"),
    cmd("make.check", "make check", "tests", "generic", "The Makefile's check target.", ("make", "check"),
        _make_target("check"), tool="make", timeout=1800),
    cmd("just.test", "just test", "tests", "generic", "The justfile's test recipe.", ("just", "test"),
        lambda c: c.has("justfile", "Justfile") and re.search(r"^test\b", c.text(
            "justfile" if "justfile" in c.fileset else "Justfile") or "", re.MULTILINE) is not None, tool="just",
        timeout=1800),
)

# Placeholders expanded per run in `expand()`: "{each:.a,.b}" becomes every repo file with those extensions,
# "{dockerfiles}" every Dockerfile. Capped so a giant repo can't build an argv past the kernel limit.
MAX_ARGS = 2000


def expand(arg: str, ctx: Ctx) -> list[str] | None:
    if arg.startswith("{each:") and arg.endswith("}"):
        exts = tuple(arg[6:-1].split(","))
        return [f for f in ctx.ext(*exts) if not f.startswith("-")][:MAX_ARGS]
    if arg == "{dockerfiles}":
        return [f for f in _dockerfiles(ctx) if not f.startswith("-")][:MAX_ARGS]
    return None

