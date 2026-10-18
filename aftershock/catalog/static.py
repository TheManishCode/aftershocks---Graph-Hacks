"""`check` scripts: pure Python over the checkout's files. Nothing here starts a process or executes repo code.

Each check yields Findings (file, line, message). Messages never echo a matched secret: they name the rule and show
a masked prefix, so a findings list is safe to show in the browser or hand to the Ask agent.
"""

from __future__ import annotations

import ast
import json
import re
import tomllib
import unicodedata
from collections.abc import Iterator
from xml.etree import ElementTree

from . import Ctx, Finding, Script, register

PY = (".py",)
JS = (".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts")
TEXT = (".py", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs",
        ".c", ".h", ".cc", ".cpp", ".hpp", ".swift", ".scala", ".sh", ".bash", ".zsh", ".md", ".rst", ".txt",
        ".json", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".html", ".css", ".scss", ".sql", ".xml", ".vue",
        ".svelte", ".tf", ".proto", ".graphql", ".dockerfile")
LOCKS = ("package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "poetry.lock", "uv.lock",
         "Pipfile.lock", "Cargo.lock", "go.sum", "Gemfile.lock", "composer.lock")
GENERATED = re.compile(r"(^|/)(dist|build|vendor|third_party|generated|__generated__)/|\.min\.(js|css)$|"
                       r"(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|uv\.lock|Cargo\.lock|"
                       r"go\.sum|Gemfile\.lock|composer\.lock)$")


def _src(ctx: Ctx, exts: tuple[str, ...]) -> list[str]:
    return [f for f in ctx.ext(*exts) if not GENERATED.search(f)]


def _is_test(f: str) -> bool:
    return bool(re.search(r"(^|/)(tests?|__tests__|spec)/|(^|/)test_[^/]*\.py$|_test\.(py|go)$|\.(test|spec)\.[jt]sx?$", f))


def _grep(ctx: Ctx, files: list[str], pat: re.Pattern, msg: str | callable, *, skip_comment: str | None = None
          ) -> Iterator[Finding]:
    for f in files:
        for n, line in ctx.lines(f):
            if skip_comment and line.lstrip().startswith(skip_comment):
                continue
            m = pat.search(line)
            if m:
                yield Finding(f, n, msg(m) if callable(msg) else msg)


def _mask(s: str) -> str:
    s = s.strip()
    return (s[:4] + "…" + f"({len(s)} chars)") if len(s) > 6 else "…"


# ---- hygiene ---------------------------------------------------------------------------------------------------------

CONFLICT = re.compile(r"^(<{7}( |$)|={7}$|>{7}( |$))")


def merge_markers(ctx: Ctx):
    for f in ctx.files:
        if f.endswith((".md", ".rst", ".txt")) and "conflict" in f.lower():
            continue
        for n, line in ctx.lines(f):
            if CONFLICT.match(line):
                yield Finding(f, n, "merge conflict marker")
                break


def large_files(ctx: Ctx):
    for f in ctx.files:
        sz = ctx.size(f)
        if sz > 5_000_000:
            yield Finding(f, None, f"{sz / 1e6:.1f} MB committed; consider Git LFS or removing it")


def trailing_ws(ctx: Ctx):
    for f in _src(ctx, TEXT):
        if f.endswith((".md", ".rst")):
            continue  # two trailing spaces are a line break in Markdown
        bad = [n for n, line in ctx.lines(f) if line != line.rstrip(" \t")]
        if bad:
            yield Finding(f, bad[0], f"trailing whitespace on {len(bad)} line{'s' * (len(bad) > 1)}")


def final_newline(ctx: Ctx):
    for f in _src(ctx, TEXT):
        t = ctx.text(f)
        if t and not t.endswith("\n"):
            yield Finding(f, len(t.splitlines()), "no newline at end of file")


def crlf(ctx: Ctx):
    for f in _src(ctx, TEXT):
        t = ctx.text(f)
        if t and "\r\n" in t and f.endswith((".bat", ".cmd", ".ps1")) is False:
            yield Finding(f, None, "CRLF line endings" + (" mixed with LF" if t.replace("\r\n", "").count("\n")
                                                         else ""))


def bom(ctx: Ctx):
    for f in _src(ctx, TEXT):
        t = ctx.text(f)
        if t and t.startswith("﻿"):
            yield Finding(f, 1, "UTF-8 byte-order mark")


def mixed_indent(ctx: Ctx):
    import io
    import tokenize

    for f in _src(ctx, PY):  # INDENT tokens only, so a tab inside a string literal is not a finding
        try:
            for tok in tokenize.generate_tokens(io.StringIO(ctx.text(f) or "").readline):
                if tok.type == tokenize.INDENT and "\t" in tok.string:
                    yield Finding(f, tok.start[0], "tab in indentation")
                    break
        except (tokenize.TokenError, SyntaxError):
            continue
    for f in _src(ctx, (".yml", ".yaml")):
        for n, line in ctx.lines(f):
            if "\t" in line[: len(line) - len(line.lstrip())]:
                yield Finding(f, n, "tab in indentation (YAML forbids it)")
                break


def empty_files(ctx: Ctx):
    for f in ctx.files:
        if ctx.size(f) == 0 and f.rsplit("/", 1)[-1] not in ("__init__.py", ".gitkeep", ".keep", "py.typed"):
            yield Finding(f, None, "empty file")


def awkward_names(ctx: Ctx):
    for f in ctx.files:
        name = f.rsplit("/", 1)[-1]
        if re.search(r"[\s]", f):
            yield Finding(f, None, "whitespace in path")
        elif any(ord(c) > 127 for c in f):
            yield Finding(f, None, "non-ASCII path")
        elif re.search(r'[<>:"|?*\\]', name):
            yield Finding(f, None, "character not allowed in Windows file names")


def case_clash(ctx: Ctx):
    seen: dict[str, str] = {}
    for f in ctx.files:
        k = unicodedata.normalize("NFC", f).lower()
        if k in seen and seen[k] != f:
            yield Finding(f, None, f"differs from {seen[k]} only by case; breaks checkouts on macOS/Windows")
        seen.setdefault(k, f)


def broken_symlinks(ctx: Ctx):
    for f in ctx.files:
        p = ctx.root / f
        if p.is_symlink():
            try:
                target = p.resolve()
            except OSError:
                yield Finding(f, None, "symlink loop")
                continue
            if not target.exists():
                yield Finding(f, None, "symlink to a missing target")
            elif not target.is_relative_to(ctx.root):
                yield Finding(f, None, "symlink points outside the repository")


ARTIFACTS = re.compile(r"(^|/)(__pycache__/|.*\.py[co]$|node_modules/|\.DS_Store$|Thumbs\.db$|.*\.egg-info/|"
                       r"\.pytest_cache/|\.coverage$|coverage\.xml$|.*\.log$|.*\.swp$|\.idea/|.*\.class$|.*\.o$)")


def build_artifacts(ctx: Ctx):
    for f in ctx.files:
        if ARTIFACTS.search(f):
            yield Finding(f, None, "generated or editor file committed; add it to .gitignore")


def gitignore_basics(ctx: Ctx):
    t = ctx.text(".gitignore") if ".gitignore" in ctx.fileset else ""
    want = []
    if ctx.ext(".py"):
        want += ["__pycache__", ".venv"]
    if ctx.has("package.json"):
        want += ["node_modules"]
    if ctx.has(".env.example", ".env.sample") or ctx.ext(".py", ".js", ".ts"):
        want += [".env"]
    for w in want:
        if not t or w not in t:
            yield Finding(".gitignore", None, f"does not ignore {w}")


def todo_count(ctx: Ctx):
    pat = re.compile(r"\b(TODO|FIXME|XXX|HACK)\b")
    for f in _src(ctx, TEXT):
        for n, line in ctx.lines(f):
            m = pat.search(line)
            if m:
                yield Finding(f, n, line.strip()[:160])


def notebook_outputs(ctx: Ctx):
    for f in ctx.ext(".ipynb"):
        try:
            nb = json.loads(ctx.text(f) or "{}")
        except ValueError:
            yield Finding(f, None, "not valid notebook JSON")
            continue
        n = sum(1 for c in nb.get("cells", []) if c.get("outputs"))
        if n:
            yield Finding(f, None, f"{n} cell{'s' * (n > 1)} with saved output (diff noise, possible data leak)")


def readme(ctx: Ctx):
    if not ctx.has("README.md", "README.rst", "README.txt", "README"):
        yield Finding("", None, "no README at the repository root")


def license_file(ctx: Ctx):
    if not any(re.match(r"^(LICEN[CS]E|COPYING)(\.|$)", f, re.IGNORECASE) for f in ctx.files if "/" not in f):
        yield Finding("", None, "no LICENSE file at the repository root")


def exec_bits(ctx: Ctx):
    for f in ctx.ext(".sh", ".bash", ".py"):
        p = ctx.path(f)
        if not p:
            continue
        first = next(iter(ctx.lines(f)), (0, ""))[1]
        x = bool(p.stat().st_mode & 0o111)
        if first.startswith("#!") and not x and f.endswith((".sh", ".bash")):
            yield Finding(f, 1, "has a shebang but is not executable")
        elif x and not first.startswith("#!") and f.endswith(".py") and "__init__" not in f:
            yield Finding(f, None, "executable but has no shebang")


# ---- security ----------------------------------------------------------------------------------------------------

SECRETS = [
    ("AWS access key id", re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("GitHub token", re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b")),
    ("GitLab token", re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}\b")),
    ("Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
    ("Slack webhook", re.compile(r"https://hooks\.slack\.com/services/[A-Za-z0-9/]{20,}")),
    ("Stripe live key", re.compile(r"\b[rs]k_live_[A-Za-z0-9]{20,}\b")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("OpenAI key", re.compile(r"\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b")),
    ("Anthropic key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{32,}\b")),
    ("OpenRouter key", re.compile(r"\bsk-or-v1-[a-f0-9]{48,}\b")),
    ("Twilio key", re.compile(r"\bSK[0-9a-fA-F]{32}\b")),
    ("SendGrid key", re.compile(r"\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b")),
    ("npm token", re.compile(r"\bnpm_[A-Za-z0-9]{36}\b")),
    ("private key block", re.compile(r"-----BEGIN ((RSA|DSA|EC|OPENSSH|PGP) )?PRIVATE KEY( BLOCK)?-----")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
    ("credentials in URL", re.compile(r"\b[a-z][a-z0-9+.-]*://[^/\s:@]{1,64}:[^/\s:@]{3,64}@[^\s/]+")),
]
ASSIGNED = re.compile(r"""(?i)\b(api[_-]?key|secret|token|passw(or)?d|auth)\w*\s*[:=]\s*["']([^"'\s]{12,})["']""")
PLACEHOLDER = re.compile(r"(?i)(example|sample|dummy|changeme|your[_-]|xxx|<|\$\{|\{\{|os\.environ|process\.env|test)")


def secrets(ctx: Ctx):
    for f in ctx.files:
        if GENERATED.search(f) or f.endswith((".lock", ".svg", ".map")):
            continue
        for n, line in ctx.lines(f):
            if len(line) > 2000:
                continue
            for label, pat in SECRETS:
                m = pat.search(line)
                if m and not PLACEHOLDER.search(m.group(0)):
                    yield Finding(f, n, f"possible {label}: {_mask(m.group(0))}")
                    break
            else:
                m = ASSIGNED.search(line)
                if m and not PLACEHOLDER.search(m.group(3)) and not _is_test(f):
                    yield Finding(f, n, f"hard-coded {m.group(1).lower()}: {_mask(m.group(3))}")


def env_files(ctx: Ctx):
    for f in ctx.files:
        name = f.rsplit("/", 1)[-1]
        if re.match(r"^\.env(\..+)?$", name) and not re.search(r"\.(example|sample|template|dist)$", name):
            yield Finding(f, None, "environment file committed; it usually holds secrets")


def key_files(ctx: Ctx):
    for f in ctx.files:
        name = f.rsplit("/", 1)[-1].lower()
        if (name in ("id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".npmrc", ".pypirc", ".netrc", "credentials.json",
                     "service-account.json") or name.endswith((".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"))):
            if name == ".npmrc" and "_authToken" not in (ctx.text(f) or ""):
                continue
            yield Finding(f, None, "key or credential file committed")


def _calls(tree: ast.AST) -> Iterator[tuple[ast.Call, str]]:
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            yield node, _dotted(node.func)


def _dotted(n: ast.AST) -> str:
    if isinstance(n, ast.Name):
        return n.id
    if isinstance(n, ast.Attribute):
        return f"{_dotted(n.value)}.{n.attr}"
    return ""


def _py_trees(ctx: Ctx, *, tests: bool | None = None) -> Iterator[tuple[str, ast.AST]]:
    for f in _src(ctx, PY):
        if tests is not None and _is_test(f) != tests:
            continue
        t = ctx.text(f)
        if t is None:
            continue
        try:
            yield f, ast.parse(t, f)
        except (SyntaxError, ValueError):
            continue


def _kw(call: ast.Call, name: str) -> ast.expr | None:
    return next((k.value for k in call.keywords if k.arg == name), None)


def _true(n: ast.expr | None) -> bool:
    return isinstance(n, ast.Constant) and n.value is True


def py_eval_exec(ctx: Ctx):
    for f, tree in _py_trees(ctx, tests=False):
        for c, name in _calls(tree):
            if name in ("eval", "exec") and not (c.args and isinstance(c.args[0], ast.Constant)):
                yield Finding(f, c.lineno, f"{name}() on a non-literal")


def py_shell_true(ctx: Ctx):
    for f, tree in _py_trees(ctx):
        for c, name in _calls(tree):
            if name.startswith("subprocess.") and _true(_kw(c, "shell")):
                yield Finding(f, c.lineno, f"{name}(shell=True): injection risk if any part is user input")
            elif name in ("os.system", "os.popen"):
                yield Finding(f, c.lineno, f"{name}() runs through the shell")


def py_unsafe_load(ctx: Ctx):
    for f, tree in _py_trees(ctx):
        for c, name in _calls(tree):
            if name in ("pickle.load", "pickle.loads", "cPickle.loads", "marshal.loads", "shelve.open"):
                yield Finding(f, c.lineno, f"{name}: deserialising untrusted data runs code")
            elif name in ("yaml.load", "yaml.load_all") and not _kw(c, "Loader") and len(c.args) < 2:
                yield Finding(f, c.lineno, f"{name} without Loader; use yaml.safe_load")
            elif name == "yaml.unsafe_load":
                yield Finding(f, c.lineno, "yaml.unsafe_load")


def py_tls_off(ctx: Ctx):
    for f, tree in _py_trees(ctx):
        for c, name in _calls(tree):
            v = _kw(c, "verify")
            if isinstance(v, ast.Constant) and v.value is False:
                yield Finding(f, c.lineno, f"{name or 'call'}(verify=False) disables TLS verification")
            elif name == "ssl._create_unverified_context":
                yield Finding(f, c.lineno, "unverified SSL context")


def py_requests_timeout(ctx: Ctx):
    verbs = {f"requests.{v}" for v in ("get", "post", "put", "patch", "delete", "head", "request")}
    for f, tree in _py_trees(ctx, tests=False):
        for c, name in _calls(tree):
            if name in verbs and _kw(c, "timeout") is None and not any(k.arg is None for k in c.keywords):
                yield Finding(f, c.lineno, f"{name}() without timeout can hang forever")


def py_sql_format(ctx: Ctx):
    for f, tree in _py_trees(ctx):
        for c, name in _calls(tree):
            if not name.endswith((".execute", ".executemany", ".raw")) or not c.args:
                continue
            a = c.args[0]
            if isinstance(a, ast.JoinedStr) or (isinstance(a, ast.BinOp) and isinstance(a.op, (ast.Mod, ast.Add))) or (
                    isinstance(a, ast.Call) and _dotted(a.func).endswith(".format")):
                yield Finding(f, c.lineno, f"{name}() with a formatted string; pass parameters instead")


def py_weak_hash(ctx: Ctx):
    for f, tree in _py_trees(ctx, tests=False):
        for c, name in _calls(tree):
            if name in ("hashlib.md5", "hashlib.sha1") and not _kw(c, "usedforsecurity"):
                yield Finding(f, c.lineno, f"{name}: weak for security use (pass usedforsecurity=False if not)")


def py_tempfile(ctx: Ctx):
    for f, tree in _py_trees(ctx):
        for c, name in _calls(tree):
            if name == "tempfile.mktemp":
                yield Finding(f, c.lineno, "tempfile.mktemp is race-prone; use mkstemp / NamedTemporaryFile")


def py_bind_all(ctx: Ctx):
    yield from _grep(ctx, _src(ctx, PY), re.compile(r"""["']0\.0\.0\.0["']"""), "binds to all interfaces",
                     skip_comment="#")


def py_debug_true(ctx: Ctx):
    for f, tree in _py_trees(ctx, tests=False):
        for node in tree.body:
            if isinstance(node, ast.Assign) and _true(node.value) and any(
                    isinstance(t, ast.Name) and t.id == "DEBUG" for t in node.targets):
                yield Finding(f, node.lineno, "DEBUG = True at module level")
        for c, name in _calls(tree):
            if name.endswith(".run") and _true(_kw(c, "debug")):
                yield Finding(f, c.lineno, f"{name}(debug=True)")


def js_eval(ctx: Ctx):
    yield from _grep(ctx, [f for f in _src(ctx, JS) if not _is_test(f)],
                     re.compile(r"(?<![\w.])(eval|new Function)\s*\("), "eval / new Function on a string",
                     skip_comment="//")


def js_inner_html(ctx: Ctx):
    yield from _grep(ctx, _src(ctx, JS), re.compile(r"dangerouslySetInnerHTML|\.innerHTML\s*=|document\.write\("),
                     lambda m: f"{m.group(0).rstrip('(= ')}: XSS risk unless the HTML is sanitised", skip_comment="//")


def js_tls_off(ctx: Ctx):
    yield from _grep(ctx, _src(ctx, JS), re.compile(r"rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED"),
                     "TLS verification disabled", skip_comment="//")


def gha_injection(ctx: Ctx):
    pat = re.compile(r"\$\{\{\s*github\.event\.(issue|pull_request|comment|review|head_commit|commits)[^}]*"
                     r"(title|body|message|head_ref|label|name)[^}]*\}\}")
    for f in _workflows(ctx):
        in_run = False
        for n, line in ctx.lines(f):
            s = line.strip()
            if re.match(r"-?\s*run\s*:", s):
                in_run = True
            elif re.match(r"-?\s*\w[\w-]*\s*:", s) and not s.startswith("#"):
                in_run = in_run and not re.match(r"-?\s*(uses|with|name|if|env)\s*:", s)
            if in_run and pat.search(line):
                yield Finding(f, n, "untrusted event text interpolated into a run: step (script injection)")


def gha_pr_target(ctx: Ctx):
    for f in _workflows(ctx):
        t = ctx.text(f) or ""
        if "pull_request_target" in t and re.search(r"ref:\s*\$\{\{\s*github\.event\.pull_request\.head", t):
            yield Finding(f, None, "pull_request_target checks out the PR head: untrusted code with secrets")


def gha_permissions(ctx: Ctx):
    for f in _workflows(ctx):
        t = ctx.text(f) or ""
        if not re.search(r"^\s*permissions\s*:", t, re.MULTILINE):
            yield Finding(f, None, "no permissions: block; the token gets the repository default")
        elif re.search(r"permissions\s*:\s*write-all", t):
            yield Finding(f, None, "permissions: write-all")


def gha_unpinned(ctx: Ctx):
    pat = re.compile(r"uses\s*:\s*['\"]?([\w.-]+/[\w./-]+)@([\w./-]+)")
    for f in _workflows(ctx):
        for n, line in ctx.lines(f):
            m = pat.search(line)
            if m and m.group(1).split("/")[0] not in ("actions", "github") and not re.fullmatch(r"[0-9a-f]{40}",
                                                                                               m.group(2)):
                yield Finding(f, n, f"{m.group(1)}@{m.group(2)} is not pinned to a commit SHA")
            elif m and m.group(2) in ("main", "master", "latest", "HEAD"):
                yield Finding(f, n, f"{m.group(1)} follows the moving ref @{m.group(2)}")


def _workflows(ctx: Ctx) -> list[str]:
    return [f for f in ctx.files if f.startswith(".github/workflows/") and f.endswith((".yml", ".yaml"))]


# ---- config validity ---------------------------------------------------------------------------------------------

def json_valid(ctx: Ctx):
    for f in ctx.ext(".json"):
        if f.rsplit("/", 1)[-1] in ("tsconfig.json", "jsconfig.json") or ".vscode/" in f or f.endswith(
                ("tsconfig.base.json",)):
            continue  # JSON with comments by convention
        t = ctx.text(f)
        if t is None:
            continue
        try:
            json.loads(t)
        except ValueError as e:
            yield Finding(f, getattr(e, "lineno", None), f"invalid JSON: {getattr(e, 'msg', str(e))}")


def yaml_valid(ctx: Ctx):
    try:
        import yaml
    except ImportError:
        yield Finding("", None, "PyYAML is not installed on the server; YAML not checked")
        return

    class Loader(yaml.SafeLoader):  # CloudFormation / Ansible tags are fine; we only check the structure
        pass

    Loader.add_multi_constructor("!", lambda loader, suffix, node: None)
    for f in ctx.ext(".yml", ".yaml"):
        t = ctx.text(f)
        if t is None:
            continue
        try:
            for _ in yaml.load_all(t, Loader=Loader):  # noqa: S506 -- SafeLoader subclass
                pass
        except yaml.YAMLError as e:
            mark = getattr(e, "problem_mark", None)
            yield Finding(f, mark.line + 1 if mark else None, f"invalid YAML: {getattr(e, 'problem', None) or e}")


def toml_valid(ctx: Ctx):
    for f in ctx.ext(".toml"):
        t = ctx.text(f)
        if t is None:
            continue
        try:
            tomllib.loads(t)
        except tomllib.TOMLDecodeError as e:
            m = re.search(r"line (\d+)", str(e))
            yield Finding(f, int(m.group(1)) if m else None, f"invalid TOML: {e}")


def xml_valid(ctx: Ctx):
    for f in ctx.ext(".xml", ".svg", ".plist", ".csproj", ".xaml"):
        t = ctx.text(f)
        if t is None or "<!ENTITY" in t:
            if t is not None:
                yield Finding(f, None, "declares XML entities; not parsed (entity expansion risk)")
            continue
        try:
            # entity declarations were refused above, and ElementTree never fetches external resources
            ElementTree.fromstring(t.encode())  # noqa: S314
        except ElementTree.ParseError as e:
            yield Finding(f, e.position[0], f"malformed XML: {e}")


def ini_valid(ctx: Ctx):
    import configparser

    for f in ctx.files:
        if not f.endswith((".ini", ".cfg")) or f.endswith(".editorconfig"):
            continue
        t = ctx.text(f)
        if t is None:
            continue
        cp = configparser.ConfigParser(interpolation=None, strict=True)
        try:
            cp.read_string(t, f)
        except configparser.Error as e:
            yield Finding(f, getattr(e, "lineno", None), f"invalid INI: {str(e).splitlines()[0]}")


def package_json_valid(ctx: Ctx):
    for f in ctx.named("package.json"):
        try:
            pj = json.loads(ctx.text(f) or "")
        except ValueError:
            yield Finding(f, None, "package.json is not valid JSON")
            continue
        if not isinstance(pj, dict):
            yield Finding(f, None, "package.json is not an object")
            continue
        if not pj.get("private") and not pj.get("name"):
            yield Finding(f, None, "no name (and not private)")
        if pj.get("private") is not True and not pj.get("license"):
            yield Finding(f, None, "no license field")
        for k in ("dependencies", "devDependencies"):
            for dep, v in (pj.get(k) or {}).items():
                if isinstance(v, str) and v in ("*", "latest", ""):
                    yield Finding(f, None, f"{dep} is pinned to {v or 'nothing'!r}")
        both = set(pj.get("dependencies") or {}) & set(pj.get("devDependencies") or {})
        for dep in sorted(both):
            yield Finding(f, None, f"{dep} is in both dependencies and devDependencies")


def _jsonc(t: str):
    """JSON with comments and trailing commas (tsconfig), stripped outside strings only."""
    out, i, n, in_str = [], 0, len(t), False
    while i < n:
        ch = t[i]
        if in_str:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(t[i + 1])
                i += 1
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
            out.append(ch)
        elif t.startswith("//", i):
            j = t.find("\n", i)
            i = n if j < 0 else j
            continue
        elif t.startswith("/*", i):
            j = t.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        else:
            out.append(ch)
        i += 1
    return json.loads(re.sub(r",(\s*[}\]])", r"\1", "".join(out)))


def tsconfig_strict(ctx: Ctx):
    for f in ctx.named("tsconfig.json"):
        try:
            cfg = _jsonc(ctx.text(f) or "")
        except ValueError:
            yield Finding(f, None, "could not parse (beyond comments and trailing commas)")
            continue
        co = cfg.get("compilerOptions") or {}
        if "extends" not in cfg and not co.get("strict"):
            yield Finding(f, None, "compilerOptions.strict is off")


def dockerfile_lint(ctx: Ctx):
    for f in [x for x in ctx.files if re.search(r"(^|/)(Dockerfile|Containerfile)([.-][\w.-]+)?$|\.dockerfile$", x)]:
        lines = list(ctx.lines(f))
        user = any(re.match(r"\s*USER\s+(?!root\b|0\b)", line, re.IGNORECASE) for _, line in lines)
        for n, line in lines:
            s = line.strip()
            if m := re.match(r"(?i)FROM\s+(--platform=\S+\s+)?(\S+)", s):
                img = m.group(2)
                if img.lower() != "scratch" and "$" not in img and "@sha256:" not in img and (
                        ":" not in img.rsplit("/", 1)[-1] or img.endswith(":latest")):
                    yield Finding(f, n, f"FROM {img}: untagged or :latest is not reproducible")
            elif re.match(r"(?i)ADD\s+(?!https?://)", s) and not re.search(r"\.(tar|tgz|gz|xz|bz2)\b", s):
                yield Finding(f, n, "ADD for local files; COPY is explicit")
            elif re.match(r"(?i)RUN\s+.*apt-get install", s) and "--no-install-recommends" not in s:
                yield Finding(f, n, "apt-get install without --no-install-recommends")
            elif re.search(r"(?i)curl[^|]*\|\s*(ba)?sh", s):
                yield Finding(f, n, "pipes a download into a shell")
            elif re.match(r"(?i)(ENV|ARG)\s+\w*(PASSWORD|SECRET|TOKEN|API_KEY)\w*[= ]\S", s):
                yield Finding(f, n, "secret baked into an image layer")
            elif re.match(r"(?i)RUN\s+sudo\b", s):
                yield Finding(f, n, "sudo in a build step")
        if not user and lines:
            yield Finding(f, None, "no USER instruction: the container runs as root")


def compose_lint(ctx: Ctx):
    for f in ctx.files:
        if not re.search(r"(^|/)(docker-)?compose(\.[\w-]+)?\.ya?ml$", f):
            continue
        for n, line in ctx.lines(f):
            s = line.strip()
            if re.match(r"privileged\s*:\s*true", s):
                yield Finding(f, n, "privileged container")
            elif "/var/run/docker.sock" in s:
                yield Finding(f, n, "mounts the Docker socket (root on the host)")
            elif re.match(r"network_mode\s*:\s*['\"]?host", s):
                yield Finding(f, n, "host networking")
            elif (m := re.match(r"-?\s*['\"]?(\d+):\d+['\"]?$", s)) and m.group(1) in (
                    "6379", "5432", "3306", "27017", "9200", "6380"):
                yield Finding(f, n, f"database port {m.group(1)} published on all interfaces")


def editorconfig(ctx: Ctx):
    if not ctx.has(".editorconfig"):
        yield Finding("", None, "no .editorconfig")


# ---- python ------------------------------------------------------------------------------------------------------

def py_syntax(ctx: Ctx):
    for f in _src(ctx, PY):
        t = ctx.text(f)
        if t is None:
            continue
        try:
            ast.parse(t, f)
        except SyntaxError as e:
            yield Finding(f, e.lineno, f"syntax error: {e.msg}")
        except ValueError as e:
            yield Finding(f, None, f"cannot parse: {e}")


def py_debugger(ctx: Ctx):
    for f, tree in _py_trees(ctx):
        for c, name in _calls(tree):
            if name in ("breakpoint", "pdb.set_trace", "ipdb.set_trace", "pudb.set_trace", "set_trace"):
                yield Finding(f, c.lineno, f"{name}() left in")


def py_print(ctx: Ctx):
    for f, tree in _py_trees(ctx, tests=False):
        if re.search(r"(^|/)(scripts?|bin|tools|examples?|docs)/|(^|/)(cli|__main__|manage|setup)\.py$", f):
            continue
        for c, name in _calls(tree):
            if name == "print":
                yield Finding(f, c.lineno, "print() in library code; use logging")


def py_bare_except(ctx: Ctx):
    for f, tree in _py_trees(ctx):
        for node in ast.walk(tree):
            if isinstance(node, ast.ExceptHandler) and node.type is None:
                yield Finding(f, node.lineno, "bare except: also catches KeyboardInterrupt and SystemExit")


def py_swallow(ctx: Ctx):
    for f, tree in _py_trees(ctx, tests=False):
        for node in ast.walk(tree):
            if (isinstance(node, ast.ExceptHandler) and len(node.body) == 1 and isinstance(node.body[0], ast.Pass)
                    and (node.type is None or _dotted(node.type) in ("Exception", "BaseException"))):
                yield Finding(f, node.lineno, "exception swallowed silently (except ...: pass)")


def py_mutable_default(ctx: Ctx):
    for f, tree in _py_trees(ctx):
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for d in node.args.defaults + [d for d in node.args.kw_defaults if d is not None]:
                    if isinstance(d, (ast.List, ast.Dict, ast.Set)) or (
                            isinstance(d, ast.Call) and _dotted(d.func) in ("list", "dict", "set")):
                        yield Finding(f, node.lineno, f"{node.name}(): mutable default argument is shared")
                        break


def py_shadow_builtins(ctx: Ctx):
    names = {"list", "dict", "str", "id", "type", "input", "len", "max", "min", "sum", "map", "filter", "object",
             "file", "format", "hash", "iter", "next", "open", "range", "set", "vars", "zip", "all", "any"}
    for f, tree in _py_trees(ctx, tests=False):
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name in names:
                yield Finding(f, node.lineno, f"defines {node.name!r}, shadowing the builtin")
            elif isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.col_offset == 0 \
                    and node.targets[0].id in names:
                yield Finding(f, node.lineno, f"module-level {node.targets[0].id!r} shadows the builtin")


def py_dup_tests(ctx: Ctx):
    """Two test functions with one name in one scope: the second silently replaces the first, which never runs."""
    for f, tree in _py_trees(ctx, tests=True):
        for scope in [tree, *[n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)]]:
            seen: dict[str, int] = {}
            for node in scope.body:
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test"):
                    if node.name in seen and not node.decorator_list:
                        yield Finding(f, node.lineno, f"{node.name} redefined (line {seen[node.name]}); "
                                                      "the earlier one never runs")
                    seen[node.name] = node.lineno


def py_empty_tests(ctx: Ctx):
    for f, tree in _py_trees(ctx, tests=True):
        if not re.search(r"(^|/)test_[^/]*\.py$|_test\.py$", f):
            continue
        has = any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name.startswith("test")
                  for n in ast.walk(tree))
        if not has:
            yield Finding(f, None, "test module with no test functions")


def py_assertless_tests(ctx: Ctx):
    for f, tree in _py_trees(ctx, tests=True):
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_"):
                body = list(ast.walk(node))
                if not any(isinstance(n, ast.Assert) for n in body) and not any(
                        isinstance(n, (ast.Call, ast.With, ast.Raise)) and re.search(
                            r"(assert|raises|warns|expect|check|verify|fail|deprecated_call)",
                            ast.unparse(n.func if isinstance(n, ast.Call) else n)[:200], re.IGNORECASE)
                        for n in body if isinstance(n, (ast.Call, ast.With, ast.Raise))):
                    yield Finding(f, node.lineno, f"{node.name} asserts nothing")


def py_skipped_tests(ctx: Ctx):
    pat = re.compile(r"@pytest\.mark\.(skip|xfail)\b(?!if)(\(\s*\))?|@unittest\.skip\b|\.skipTest\(")
    for f in [x for x in _src(ctx, PY) if _is_test(x)]:
        for n, line in ctx.lines(f):
            m = pat.search(line)
            if m and "reason" not in line:
                yield Finding(f, n, f"{m.group(0).lstrip('@.')} without a reason")


def py_assert_tuple(ctx: Ctx):
    for f, tree in _py_trees(ctx):
        for node in ast.walk(tree):
            if isinstance(node, ast.Assert) and isinstance(node.test, ast.Tuple) and node.test.elts:
                yield Finding(f, node.lineno, "assert on a tuple is always true")


def py_is_literal(ctx: Ctx):
    for f, tree in _py_trees(ctx):
        for node in ast.walk(tree):
            if isinstance(node, ast.Compare):
                for op, right in zip(node.ops, node.comparators, strict=False):
                    if isinstance(op, (ast.Is, ast.IsNot)) and isinstance(right, ast.Constant) and \
                            right.value not in (None, True, False, ...):
                        yield Finding(f, node.lineno, "`is` comparison with a literal; use ==")


def py_star_import(ctx: Ctx):
    for f, tree in _py_trees(ctx):
        if f.endswith("__init__.py"):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and any(a.name == "*" for a in node.names):
                yield Finding(f, node.lineno, f"from {node.module} import *")


def py_dup_keys(ctx: Ctx):
    for f, tree in _py_trees(ctx):
        for node in ast.walk(tree):
            if isinstance(node, ast.Dict):
                seen = set()
                for k in node.keys:
                    if isinstance(k, ast.Constant) and isinstance(k.value, (str, int)):
                        if k.value in seen:
                            yield Finding(f, k.lineno, f"duplicate dict key {k.value!r}; the first value is lost")
                        seen.add(k.value)


def py_unreachable(ctx: Ctx):
    for f, tree in _py_trees(ctx):
        for node in ast.walk(tree):
            body = getattr(node, "body", None)
            if not isinstance(body, list):
                continue
            for a, b in zip(body, body[1:], strict=False):
                if isinstance(a, (ast.Return, ast.Raise, ast.Continue, ast.Break)):
                    yield Finding(f, b.lineno, "unreachable code after " + type(a).__name__.lower())
                    break


def py_fstring_no_placeholder(ctx: Ctx):
    for f, tree in _py_trees(ctx):
        parents = {id(v) for n in ast.walk(tree) if isinstance(n, ast.JoinedStr) for v in n.values
                   if isinstance(v, ast.FormattedValue) for v in ast.walk(v.format_spec or ast.Constant(None))}
        for node in ast.walk(tree):
            if isinstance(node, ast.JoinedStr) and id(node) not in parents and \
                    not any(isinstance(v, ast.FormattedValue) for v in node.values):
                yield Finding(f, node.lineno, "f-string without placeholders")


def py_init_missing(ctx: Ctx):
    """A directory of .py modules that is imported as a package but has no __init__.py (namespace by accident)."""
    pkgs = {f.rsplit("/", 1)[0] for f in _src(ctx, PY) if "/" in f}
    for d in sorted(pkgs):
        if _is_test(d + "/x.py") or re.search(r"(^|/)(scripts?|examples?|docs|bin|tools|migrations)(/|$)", d):
            continue
        if f"{d}/__init__.py" not in ctx.fileset and any(f"{p}/__init__.py" in ctx.fileset
                                                          for p in [d.rsplit("/", 1)[0]] if "/" in d):
            yield Finding(d, None, "inside a package but has no __init__.py")


def py_requirements_pinned(ctx: Ctx):
    for f in [x for x in ctx.files if re.search(r"(^|/)requirements[\w.-]*\.(txt|in)$", x)]:
        if f.endswith(".in"):
            continue
        for n, line in ctx.lines(f):
            s = line.split("#", 1)[0].strip()
            if not s or s.startswith(("-", "git+", "http")):
                continue
            if not re.search(r"==|===|@", s):
                yield Finding(f, n, f"{s} is not pinned")


def py_project_meta(ctx: Ctx):
    t = ctx.text("pyproject.toml") if "pyproject.toml" in ctx.fileset else None
    if t is None:
        return
    try:
        d = tomllib.loads(t)
    except tomllib.TOMLDecodeError:
        return
    proj = d.get("project")
    if proj is None:
        return
    if "requires-python" not in proj:
        yield Finding("pyproject.toml", None, "[project] has no requires-python")
    if "build-system" not in d:
        yield Finding("pyproject.toml", None, "no [build-system]")
    for dep in proj.get("dependencies", []):
        if isinstance(dep, str) and not re.search(r"[<>=~!@]", dep):
            yield Finding("pyproject.toml", None, f"dependency {dep!r} has no version bound")


def py_conftest_side_effects(ctx: Ctx):
    for f, tree in _py_trees(ctx):
        if not f.endswith("conftest.py"):
            continue
        for node in tree.body:
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
                name = _dotted(node.value.func)
                if name and not name.startswith(("pytest.", "register", "warnings.")):
                    yield Finding(f, node.lineno, f"{name}() runs at import of every test session")


def py_circular_imports(ctx: Ctx):
    """Module-level import cycles between this repo's own modules (static; function-local imports are ignored)."""
    mods: dict[str, str] = {}
    for f in _src(ctx, PY):
        m = f[:-3].replace("/", ".")
        for prefix in ("src.", "lib."):
            m = m.removeprefix(prefix)
        mods[m.removesuffix(".__init__")] = f
    edges: dict[str, set[str]] = {m: set() for m in mods}
    for m, f in mods.items():
        t = ctx.text(f)
        try:
            tree = ast.parse(t or "", f)
        except (SyntaxError, ValueError):
            continue
        pkg = m if f.endswith("__init__.py") else m.rpartition(".")[0]
        for node in tree.body:  # module level only
            names = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                base = node.module or ""
                if node.level:
                    parts = pkg.split(".")
                    base = ".".join(parts[: len(parts) - node.level + 1] + ([base] if base else []))
                names = [base] + [f"{base}.{a.name}" for a in node.names]
            for n in names:
                while n and n not in mods:
                    n = n.rpartition(".")[0]
                if n and n != m:
                    edges[m].add(n)
    seen_cycles: set[frozenset] = set()
    color: dict[str, int] = {}
    stack: list[str] = []

    def dfs(u: str):
        color[u] = 1
        stack.append(u)
        for v in sorted(edges[u]):
            if color.get(v) == 1:
                cyc = stack[stack.index(v):]
                key = frozenset(cyc)
                if key not in seen_cycles and len(seen_cycles) < 50:
                    seen_cycles.add(key)
                    yield Finding(mods[v], None, "import cycle: " + " → ".join(cyc + [v]))
            elif v not in color:
                yield from dfs(v)
        stack.pop()
        color[u] = 2

    import sys

    old = sys.getrecursionlimit()
    sys.setrecursionlimit(max(old, 10000))
    try:
        for m in sorted(mods):
            if m not in color:
                yield from dfs(m)
    finally:
        sys.setrecursionlimit(old)


# ---- javascript / typescript -------------------------------------------------------------------------------------

def js_focused_tests(ctx: Ctx):
    yield from _grep(ctx, [f for f in _src(ctx, JS) if _is_test(f)],
                     re.compile(r"\b(it|test|describe|context)\.only\s*\(|\bf(it|describe)\s*\("),
                     lambda m: f"{m.group(0).rstrip('( ')}: the rest of the suite is silently skipped",
                     skip_comment="//")


def js_skipped_tests(ctx: Ctx):
    yield from _grep(ctx, [f for f in _src(ctx, JS) if _is_test(f)],
                     re.compile(r"\b(it|test|describe)\.(skip|todo)\s*\(|\bx(it|describe)\s*\("),
                     lambda m: f"{m.group(0).rstrip('( ')}", skip_comment="//")


def js_debugger(ctx: Ctx):
    yield from _grep(ctx, _src(ctx, JS), re.compile(r"^\s*debugger\s*;?\s*$"), "debugger statement")


def js_console(ctx: Ctx):
    yield from _grep(ctx, [f for f in _src(ctx, JS) if not _is_test(f) and not re.search(
        r"(^|/)(scripts?|bin|cli|tools)/|\.config\.[cm]?[jt]s$", f)],
                     re.compile(r"\bconsole\.(log|debug|trace|dir)\("), lambda m: f"{m.group(0)[:-1]} left in",
                     skip_comment="//")


def js_ts_ignore(ctx: Ctx):
    yield from _grep(ctx, _src(ctx, (".ts", ".tsx", ".mts", ".cts")),
                     re.compile(r"@ts-(ignore|nocheck)\b"), lambda m: f"@ts-{m.group(1)} hides type errors")


def js_any(ctx: Ctx):
    yield from _grep(ctx, [f for f in _src(ctx, (".ts", ".tsx")) if not f.endswith(".d.ts")],
                     re.compile(r":\s*any\b(?!\w)|\bas\s+any\b|<any>"), "explicit any", skip_comment="//")


def js_lockfiles(ctx: Ctx):
    have = [x for x in ("package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock")
            if x in ctx.fileset]
    if len(have) > 1:
        yield Finding(have[0], None, f"several lockfiles ({', '.join(have)}): installs differ by package manager")
    elif ctx.has("package.json") and "package.json" in ctx.fileset and not have and (
            ctx.package_json.get("dependencies") or ctx.package_json.get("devDependencies")):
        yield Finding("package.json", None, "dependencies but no lockfile: installs are not reproducible")


def js_engines(ctx: Ctx):
    if "package.json" in ctx.fileset and not ctx.package_json.get("engines") and not ctx.has(".nvmrc",
                                                                                              ".node-version"):
        yield Finding("package.json", None, "no engines.node, .nvmrc or .node-version: the Node version is a guess")


def js_test_script(ctx: Ctx):
    s = (ctx.package_json.get("scripts") or {}).get("test", "")
    if "package.json" in ctx.fileset and (not s or "no test specified" in s):
        yield Finding("package.json", None, "no real `test` script")


def js_env_leak(ctx: Ctx):
    """Next.js/Vite expose NEXT_PUBLIC_* / VITE_* to the browser; a secret-sounding name there ships to users."""
    yield from _grep(ctx, _src(ctx, JS) + [f for f in ctx.files if re.search(r"(^|/)\.env[\w.-]*$", f)],
                     re.compile(r"\b(NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC)_\w*(SECRET|PRIVATE|PASSWORD|TOKEN|"
                                r"API_KEY|SERVICE_ROLE)\w*"),
                     lambda m: f"{m.group(0)} is bundled into client code")


# ---- go / rust / shell / misc ------------------------------------------------------------------------------------

def go_debug(ctx: Ctx):
    yield from _grep(ctx, [f for f in ctx.ext(".go") if not f.endswith("_test.go")],
                     re.compile(r"\b(fmt\.Print(ln|f)?|println)\("), "print left in non-test Go code",
                     skip_comment="//")


def go_ignored_err(ctx: Ctx):
    yield from _grep(ctx, [f for f in ctx.ext(".go") if not f.endswith("_test.go")],
                     re.compile(r"^\s*_\s*(,\s*_\s*)?=\s*\w[\w.]*\("), "error result discarded with _",
                     skip_comment="//")


def rust_unwrap(ctx: Ctx):
    yield from _grep(ctx, [f for f in ctx.ext(".rs") if "/tests/" not in f and not f.startswith("tests/")],
                     re.compile(r"\.unwrap\(\)|\.expect\(\s*\)"), "unwrap() panics on error", skip_comment="//")


def rust_unsafe(ctx: Ctx):
    yield from _grep(ctx, ctx.ext(".rs"), re.compile(r"\bunsafe\s*\{"), "unsafe block", skip_comment="//")


def shell_strict(ctx: Ctx):
    for f in ctx.ext(".sh", ".bash"):
        t = ctx.text(f) or ""
        head = "\n".join(t.splitlines()[:15])
        if not re.search(r"set\s+-[a-z]*e|set\s+-o\s+errexit", head):
            yield Finding(f, 1, "no `set -e` (or -euo pipefail): failures are ignored")


def shell_shebang(ctx: Ctx):
    for f in ctx.ext(".sh", ".bash"):
        first = next(iter(ctx.lines(f)), (0, ""))[1]
        if not first.startswith("#!"):
            yield Finding(f, 1, "no shebang")


def shell_unquoted(ctx: Ctx):
    yield from _grep(ctx, ctx.ext(".sh", ".bash"),
                     re.compile(r"\brm\s+-[a-z]*r[a-z]*f?\s+\$\w+(?![\w\"])|\brm\s+-rf\s+\"?\$\{?\w+\}?/\*?\"?\s*$"),
                     "rm -r on an unquoted / possibly empty variable", skip_comment="#")


def make_phony(ctx: Ctx):
    for f in ctx.named("Makefile", "makefile", "GNUmakefile"):
        t = ctx.text(f) or ""
        targets = set(re.findall(r"^([A-Za-z][\w-]*)\s*:(?!=)", t, re.MULTILINE))
        phony = set(" ".join(re.findall(r"^\.PHONY\s*:\s*(.+)$", t, re.MULTILINE)).split())
        for name in sorted(targets & {"test", "lint", "build", "clean", "all", "install", "run", "check", "fmt"}
                           - phony):
            yield Finding(f, None, f"target {name!r} is not .PHONY (a file named {name} would skip it)")


def doc_links(ctx: Ctx):
    """Relative links in Markdown that point at files which don't exist."""
    pat = re.compile(r"\]\((?!https?:|mailto:|#|//)([^)\s#?]+)")
    for f in ctx.ext(".md"):
        base = f.rsplit("/", 1)[0] + "/" if "/" in f else ""
        for n, line in ctx.lines(f):
            for m in pat.finditer(line):
                target = m.group(1)
                path = (base + target).replace("/./", "/")
                parts: list[str] = []
                for p in path.split("/"):
                    if p == "..":
                        if parts:
                            parts.pop()
                    elif p and p != ".":
                        parts.append(p)
                norm = "/".join(parts)
                if norm and norm not in ctx.fileset and not any(x.startswith(norm.rstrip("/") + "/")
                                                                for x in ctx.files):
                    yield Finding(f, n, f"broken link to {target}")


def long_lines(ctx: Ctx):
    for f in _src(ctx, PY + JS + (".go", ".rs", ".java")):
        n_long = [n for n, line in ctx.lines(f) if len(line) > 160]
        if n_long:
            yield Finding(f, n_long[0], f"{len(n_long)} line{'s' * (len(n_long) > 1)} over 160 characters")


def big_functions(ctx: Ctx):
    for f, tree in _py_trees(ctx, tests=False):
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                n = (node.end_lineno or node.lineno) - node.lineno + 1
                if n > 120:
                    yield Finding(f, node.lineno, f"{node.name}() is {n} lines long")


def py_complexity(ctx: Ctx):
    branch = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.Try, ast.With, ast.AsyncWith, ast.ExceptHandler,
              ast.BoolOp, ast.IfExp, ast.comprehension, ast.Match)
    for f, tree in _py_trees(ctx, tests=False):
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                cc = 1 + sum(isinstance(n, branch) for n in ast.walk(node))
                if cc > 20:
                    yield Finding(f, node.lineno, f"{node.name}(): cyclomatic complexity ~{cc}")


def py_missing_docstrings(ctx: Ctx):
    for f, tree in _py_trees(ctx, tests=False):
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and \
                    not node.name.startswith("_") and ast.get_docstring(node) is None:
                yield Finding(f, node.lineno, f"public {type(node).__name__.replace('Def', '').lower()} "
                                              f"{node.name} has no docstring")


# ---- registration ------------------------------------------------------------------------------------------------

def _py(c: Ctx) -> bool:
    return bool(c.ext(".py"))


def _pytests(c: Ctx) -> bool:
    return any(_is_test(f) for f in c.ext(".py"))


def _js(c: Ctx) -> bool:
    return bool(c.ext(*JS))


def _jstests(c: Ctx) -> bool:
    return any(_is_test(f) for f in c.ext(*JS))


def _ts(c: Ctx) -> bool:
    return bool(c.ext(".ts", ".tsx"))


def _gha(c: Ctx) -> bool:
    return bool(_workflows(c))


def _docker(c: Ctx) -> bool:
    return any(re.search(r"(^|/)(Dockerfile|Containerfile)([.-][\w.-]+)?$|\.dockerfile$", f) for f in c.files)


def _compose(c: Ctx) -> bool:
    return any(re.search(r"(^|/)(docker-)?compose(\.[\w-]+)?\.ya?ml$", f) for f in c.files)


def _sh(c: Ctx) -> bool:
    return bool(c.ext(".sh", ".bash"))


def _always(c: Ctx) -> bool:
    return True


def chk(id_, name, cat, eco, summary, fn, applies=_always, severity="warn", tags=()):
    return Script(id=id_, name=name, category=cat, ecosystem=eco, summary=summary, kind="check", fn=fn,
                  applies=applies, severity=severity, tags=tuple(tags))


register(
    # hygiene
    chk("repo.merge-markers", "Merge conflict markers", "hygiene", "generic",
        "Leftover <<<<<<< / ======= / >>>>>>> lines from an unfinished merge.", merge_markers, severity="error"),
    chk("repo.large-files", "Large files", "hygiene", "generic", "Files over 5 MB committed to the repository.",
        large_files),
    chk("repo.trailing-whitespace", "Trailing whitespace", "hygiene", "generic",
        "Lines ending in spaces or tabs (Markdown excluded).", trailing_ws, severity="info"),
    chk("repo.final-newline", "Missing final newline", "hygiene", "generic",
        "Text files that don't end with a newline.", final_newline, severity="info"),
    chk("repo.line-endings", "CRLF line endings", "hygiene", "generic",
        "Windows line endings, or a file mixing CRLF and LF.", crlf, severity="info"),
    chk("repo.bom", "Byte-order marks", "hygiene", "generic", "UTF-8 files starting with a BOM.", bom,
        severity="info"),
    chk("repo.tab-indent", "Tabs in indentation", "hygiene", "generic",
        "Tabs indenting Python or YAML, where they break or mislead.", mixed_indent),
    chk("repo.empty-files", "Empty files", "hygiene", "generic", "Zero-byte files (package markers excluded).",
        empty_files, severity="info"),
    chk("repo.awkward-paths", "Awkward file names", "hygiene", "generic",
        "Whitespace, non-ASCII, or Windows-illegal characters in paths.", awkward_names),
    chk("repo.case-clash", "Case-insensitive clashes", "hygiene", "generic",
        "Paths differing only by case, which collide on macOS and Windows.", case_clash, severity="error"),
    chk("repo.symlinks", "Broken or escaping symlinks", "hygiene", "generic",
        "Symlinks to missing targets or to paths outside the repository.", broken_symlinks),
    chk("repo.build-artifacts", "Committed build artifacts", "hygiene", "generic",
        "__pycache__, .pyc, node_modules, .DS_Store, logs and other generated files in the tree.", build_artifacts),
    chk("repo.gitignore", ".gitignore basics", "hygiene", "generic",
        "Ignores the usual suspects for this stack: .venv, __pycache__, node_modules, .env.", gitignore_basics),
    chk("repo.todos", "TODO / FIXME inventory", "hygiene", "generic", "Every TODO, FIXME, XXX and HACK comment.",
        todo_count, severity="info", tags=("debt",)),
    chk("repo.notebook-outputs", "Notebook outputs", "hygiene", "python",
        "Jupyter notebooks committed with cell outputs.", notebook_outputs, applies=lambda c: bool(c.ext(".ipynb"))),
    chk("repo.readme", "README present", "hygiene", "generic", "A README at the repository root.", readme),
    chk("repo.license", "LICENSE present", "hygiene", "generic", "A LICENSE or COPYING file at the root.",
        license_file),
    chk("repo.exec-bits", "Executable bits", "hygiene", "shell",
        "Scripts with a shebang that aren't executable, or executables with no shebang.", exec_bits,
        applies=lambda c: bool(c.ext(".sh", ".bash", ".py"))),
    chk("repo.editorconfig", ".editorconfig present", "hygiene", "generic",
        "An .editorconfig so editors agree on indentation and line endings.", editorconfig, severity="info"),
    chk("repo.doc-links", "Broken relative links in docs", "hygiene", "generic",
        "Markdown links to files that aren't in the repository.", doc_links, applies=lambda c: bool(c.ext(".md"))),
    chk("repo.long-lines", "Very long lines", "lint", "generic", "Source lines over 160 characters.", long_lines,
        severity="info"),
    # security
    chk("sec.secrets", "Secret scan", "security", "generic",
        "Cloud keys, tokens, private keys, JWTs, credentials in URLs and hard-coded passwords. Matches are masked.",
        secrets, severity="error", tags=("credentials", "leak")),
    chk("sec.env-files", "Committed .env files", "security", "generic",
        ".env files in the tree (examples and templates excluded).", env_files, severity="error"),
    chk("sec.key-files", "Committed key files", "security", "generic",
        "Private keys, keystores, .pypirc/.netrc and npm auth tokens.", key_files, severity="error"),
    chk("sec.py-eval", "eval / exec", "security", "python", "eval() or exec() on anything but a literal.",
        py_eval_exec, applies=_py),
    chk("sec.py-shell", "Shell injection", "security", "python",
        "subprocess with shell=True, os.system and os.popen.", py_shell_true, applies=_py),
    chk("sec.py-deserialise", "Unsafe deserialisation", "security", "python",
        "pickle / marshal / shelve loads and yaml.load without a safe Loader.", py_unsafe_load, applies=_py),
    chk("sec.py-tls", "TLS verification off", "security", "python",
        "verify=False and unverified SSL contexts.", py_tls_off, applies=_py),
    chk("sec.py-requests-timeout", "HTTP calls without timeout", "security", "python",
        "requests.get/post/... with no timeout, which can hang a worker forever.", py_requests_timeout, applies=_py),
    chk("sec.py-sql", "SQL built from strings", "security", "python",
        "cursor.execute() with f-strings, % or .format instead of parameters.", py_sql_format, applies=_py,
        severity="error", tags=("injection",)),
    chk("sec.py-weak-hash", "Weak hashes", "security", "python", "MD5 / SHA-1 outside tests.", py_weak_hash,
        applies=_py, severity="info"),
    chk("sec.py-mktemp", "Insecure temp files", "security", "python", "tempfile.mktemp race conditions.",
        py_tempfile, applies=_py),
    chk("sec.py-bind-all", "Binding to 0.0.0.0", "security", "python", "Servers listening on every interface.",
        py_bind_all, applies=_py, severity="info"),
    chk("sec.py-debug", "Debug mode on", "security", "python", "DEBUG = True or app.run(debug=True).",
        py_debug_true, applies=_py),
    chk("sec.js-eval", "eval / new Function", "security", "node", "Dynamic code from strings in JS/TS.", js_eval,
        applies=_js),
    chk("sec.js-html", "Raw HTML injection", "security", "node",
        "dangerouslySetInnerHTML, innerHTML assignment and document.write.", js_inner_html, applies=_js),
    chk("sec.js-tls", "TLS verification off (Node)", "security", "node",
        "rejectUnauthorized: false and NODE_TLS_REJECT_UNAUTHORIZED.", js_tls_off, applies=_js),
    chk("sec.js-public-env", "Secrets in public env vars", "security", "node",
        "NEXT_PUBLIC_ / VITE_ / REACT_APP_ variables named like secrets — they ship to the browser.", js_env_leak,
        applies=_js, severity="error"),
    chk("sec.gha-injection", "Actions script injection", "security", "ci",
        "Issue/PR titles, bodies or branch names interpolated straight into run: steps.", gha_injection,
        applies=_gha, severity="error"),
    chk("sec.gha-pr-target", "pull_request_target checkout", "security", "ci",
        "Workflows that check out untrusted PR code with a privileged token.", gha_pr_target, applies=_gha,
        severity="error"),
    chk("sec.gha-permissions", "Workflow token permissions", "security", "ci",
        "Workflows without a permissions: block, or with write-all.", gha_permissions, applies=_gha),
    chk("sec.gha-pinning", "Unpinned third-party actions", "security", "ci",
        "Third-party actions referenced by tag or branch instead of a commit SHA.", gha_unpinned, applies=_gha),
    chk("sec.compose", "Risky Compose settings", "security", "docker",
        "Privileged containers, Docker socket mounts, host networking, databases published publicly.", compose_lint,
        applies=_compose),
    # config
    chk("cfg.json", "JSON validity", "config", "generic", "Every .json file parses (tsconfig-style JSONC skipped).",
        json_valid, applies=lambda c: bool(c.ext(".json")), severity="error"),
    chk("cfg.yaml", "YAML validity", "config", "generic", "Every .yml/.yaml file parses.", yaml_valid,
        applies=lambda c: bool(c.ext(".yml", ".yaml")), severity="error"),
    chk("cfg.toml", "TOML validity", "config", "generic", "Every .toml file parses.", toml_valid,
        applies=lambda c: bool(c.ext(".toml")), severity="error"),
    chk("cfg.xml", "XML well-formedness", "config", "generic", "XML, SVG and project files are well formed.",
        xml_valid, applies=lambda c: bool(c.ext(".xml", ".svg", ".plist", ".csproj", ".xaml")), severity="error"),
    chk("cfg.ini", "INI / cfg validity", "config", "generic", "setup.cfg, tox.ini and other INI files parse.",
        ini_valid, applies=lambda c: bool(c.ext(".ini", ".cfg")), severity="error"),
    chk("cfg.dockerfile", "Dockerfile lint", "config", "docker",
        "Untagged base images, ADD vs COPY, curl | sh, secrets in ENV, running as root.", dockerfile_lint,
        applies=_docker),
    chk("cfg.package-json", "package.json sanity", "deps", "node",
        "Valid, named, licensed, no `*`/`latest` versions, no package in both dependency lists.",
        package_json_valid, applies=lambda c: c.has("package.json")),
    chk("cfg.tsconfig-strict", "TypeScript strict mode", "types", "node", "tsconfig.json has strict: true.",
        tsconfig_strict, applies=lambda c: c.has("tsconfig.json")),
    chk("cfg.makefile-phony", "Makefile .PHONY", "config", "generic",
        "Common targets (test, build, clean, ...) declared .PHONY.", make_phony,
        applies=lambda c: c.has("Makefile", "makefile", "GNUmakefile"), severity="info"),
    # deps
    chk("deps.py-pins", "Unpinned requirements", "deps", "python", "requirements*.txt lines without ==.",
        py_requirements_pinned, applies=lambda c: any(re.search(r"(^|/)requirements[\w.-]*\.txt$", f)
                                                       for f in c.files)),
    chk("deps.pyproject", "pyproject metadata", "deps", "python",
        "requires-python, a build-system, and version bounds on dependencies.", py_project_meta,
        applies=lambda c: "pyproject.toml" in c.fileset),
    chk("deps.js-lockfile", "Lockfile discipline", "deps", "node",
        "Exactly one lockfile for the package manager in use.", js_lockfiles, applies=lambda c: c.has("package.json")),
    chk("deps.js-engines", "Node version declared", "deps", "node", "engines.node, .nvmrc or .node-version.",
        js_engines, applies=lambda c: "package.json" in c.fileset, severity="info"),
    # build (static)
    chk("py.syntax", "Python syntax", "build", "python",
        "Every .py file parses with the server's Python (no code is executed).", py_syntax, applies=_py,
        severity="error"),
    chk("py.import-cycles", "Import cycles", "build", "python",
        "Module-level import cycles between the repo's own modules.", py_circular_imports, applies=_py),
    chk("py.init-missing", "Missing __init__.py", "build", "python",
        "Sub-directories of a package with no __init__.py.", py_init_missing, applies=_py, severity="info"),
    # python lint (AST)
    chk("py.debugger", "Debugger calls", "lint", "python", "breakpoint() and pdb/ipdb set_trace() left in.",
        py_debugger, applies=_py, severity="error"),
    chk("py.print", "print() in library code", "lint", "python",
        "print() outside tests, scripts and CLIs.", py_print, applies=_py, severity="info"),
    chk("py.bare-except", "Bare except", "lint", "python", "except: with no exception type.", py_bare_except,
        applies=_py),
    chk("py.swallowed", "Swallowed exceptions", "lint", "python", "except Exception: pass.", py_swallow,
        applies=_py),
    chk("py.mutable-defaults", "Mutable default arguments", "lint", "python",
        "def f(x=[]) and friends, shared between calls.", py_mutable_default, applies=_py),
    chk("py.shadowed-builtins", "Shadowed builtins", "lint", "python",
        "Functions, classes or module globals named list, id, type, ...", py_shadow_builtins, applies=_py,
        severity="info"),
    chk("py.assert-tuple", "assert on a tuple", "lint", "python", "assert (x, 'msg') is always true.",
        py_assert_tuple, applies=_py, severity="error"),
    chk("py.is-literal", "`is` with a literal", "lint", "python", "x is 'a' / x is 1 instead of ==.",
        py_is_literal, applies=_py),
    chk("py.star-import", "Star imports", "lint", "python", "from x import * outside __init__.py.",
        py_star_import, applies=_py, severity="info"),
    chk("py.dup-keys", "Duplicate dict keys", "lint", "python", "Dict literals repeating a key.", py_dup_keys,
        applies=_py, severity="error"),
    chk("py.unreachable", "Unreachable code", "lint", "python", "Statements after return/raise/continue/break.",
        py_unreachable, applies=_py),
    chk("py.fstring", "f-strings without placeholders", "lint", "python", "f\"...\" with nothing to format.",
        py_fstring_no_placeholder, applies=_py, severity="info"),
    chk("py.big-functions", "Very long functions", "lint", "python", "Functions over 120 lines.", big_functions,
        applies=_py, severity="info", tags=("complexity",)),
    chk("py.complexity", "High cyclomatic complexity", "lint", "python",
        "Functions with roughly more than 20 branches.", py_complexity, applies=_py, severity="info",
        tags=("complexity",)),
    chk("py.docstrings", "Public API docstrings", "lint", "python",
        "Top-level public functions and classes without a docstring.", py_missing_docstrings, applies=_py,
        severity="info"),
    # python tests (static)
    chk("pytest.duplicate-names", "Shadowed test functions", "tests", "python",
        "Two tests with the same name in one module or class: the first never runs.", py_dup_tests,
        applies=_pytests, severity="error"),
    chk("pytest.empty-modules", "Test modules with no tests", "tests", "python",
        "test_*.py files that define no test function.", py_empty_tests, applies=_pytests),
    chk("pytest.assertless", "Tests that assert nothing", "tests", "python",
        "Test functions with no assert, pytest.raises, or assert-like call.", py_assertless_tests, applies=_pytests),
    chk("pytest.skips", "Skips without a reason", "tests", "python",
        "@pytest.mark.skip / xfail / unittest.skip with no reason given.", py_skipped_tests, applies=_pytests,
        severity="info"),
    chk("pytest.conftest-side-effects", "conftest side effects", "tests", "python",
        "Calls at conftest.py module level that run for every session.", py_conftest_side_effects, applies=_pytests,
        severity="info"),
    # js/ts (static)
    chk("js.focused-tests", "Focused tests (.only)", "tests", "node",
        "it.only / describe.only / fit, which silently skip the rest of the suite.", js_focused_tests,
        applies=_jstests, severity="error"),
    chk("js.skipped-tests", "Skipped tests", "tests", "node", "it.skip / xit / test.todo inventory.",
        js_skipped_tests, applies=_jstests, severity="info"),
    chk("js.debugger", "debugger statements", "lint", "node", "debugger; left in JS/TS.", js_debugger, applies=_js,
        severity="error"),
    chk("js.console", "console.log left in", "lint", "node", "console.log/debug/trace in application code.",
        js_console, applies=_js, severity="info"),
    chk("ts.ignore", "@ts-ignore / @ts-nocheck", "types", "node", "Comments that switch the type checker off.",
        js_ts_ignore, applies=_ts),
    chk("ts.any", "Explicit any", "types", "node", ": any, as any and <any> in TypeScript.", js_any, applies=_ts,
        severity="info"),
    chk("js.test-script", "npm test script", "tests", "node", "package.json has a real `test` script.",
        js_test_script, applies=lambda c: "package.json" in c.fileset),
    # other languages
    chk("go.prints", "Print statements in Go", "lint", "go", "fmt.Print*/println outside _test.go.", go_debug,
        applies=lambda c: bool(c.ext(".go")), severity="info"),
    chk("go.ignored-errors", "Discarded errors", "lint", "go", "_ = f() / _, _ = f() discarding an error.",
        go_ignored_err, applies=lambda c: bool(c.ext(".go"))),
    chk("rust.unwrap", "unwrap() in Rust", "lint", "rust", ".unwrap() outside tests.", rust_unwrap,
        applies=lambda c: bool(c.ext(".rs")), severity="info"),
    chk("rust.unsafe", "unsafe blocks", "security", "rust", "Every unsafe { } block, for review.", rust_unsafe,
        applies=lambda c: bool(c.ext(".rs")), severity="info"),
    chk("sh.strict-mode", "Shell strict mode", "lint", "shell", "Scripts without set -e / -euo pipefail.",
        shell_strict, applies=_sh),
    chk("sh.shebang", "Shell shebang", "lint", "shell", "Shell scripts without a #! line.", shell_shebang,
        applies=_sh),
    chk("sh.rm-var", "rm -rf on a variable", "security", "shell",
        "rm -r on an unquoted or possibly empty variable.", shell_unquoted, applies=_sh, severity="error"),
)
