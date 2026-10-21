"""S6 static brittleness detector for pytest files. Standard library only (ast).

Usage: python3 plans/spikes/s6/detect_py.py <suite-root> [tests-dir=tests] [--strict] > brittle-py.json

Output: {"tests": [{"file", "name", "line", "endLine", "shape", "flags": [{"kind", "line", "evidence"}]}]}
`shape` is the test body's tokens with literals masked (strings S, numbers N), for body similarity.
`name` is the function name, or Class::name for methods (pytest node ids minus parameters).

Patterns (the same four as detect-js.mjs). A read counts only when its path is in the repository (it mentions
__file__ or a module-level constant derived from it, such as ROOT = Path(__file__).parents[1]), so reading
files the code under test wrote into tmp_path, or throwaway repositories built under tmp_path, are never flagged.
  source-text   a repository code file (.py .ts .tsx .rs .sh .html .toml .yml .sql, or under src/ hub-ts/ scripts/
                web/ native/ tools/) read as text (read_text, read_bytes, open().read(), inspect.getsource), directly,
                through a module-level name, a module-level helper or a fixture that holds one; and an assert that
                tests text: `in`/`not in`, ==, re.search/match/findall, startswith/endswith/count
  doc-wording   the same for documentation (.md .txt, docs/, README, AGENTS.md, CLAUDE.md)
  css-class     a .css file read as above, or a string in the test that pins class names (class=, className,
                classList)
  file-snapshot an == assert where one side is a whole-file read of a repository or fixture file (or a name
                holding one), or a snapshot fixture or API

--strict (the tuned detector, v1) fixes the false positives found in the S6 hand-check:
  - a read wrapped in a parser (json.loads, tomllib.loads, yaml.safe_load, ast.parse) is data, not text
  - a helper counts as a reader only when it returns the read directly (`return (ROOT / p).read_text()`), not
    when it hashes or parses it (digest pins of frozen inputs are deliberate provenance checks)
  - css-class strings count only inside assert statements, not in input data
"""
from __future__ import annotations

import ast
import io
import json
import os
import re
import sys
import tokenize

STRICT = False
PARSERS = {'loads', 'safe_load', 'load', 'parse', 'literal_eval'}

ROOTISH = re.compile(r"(^|_)(ROOT|REPO|HERE|BASE|PROJECT)(_|$)|^(ROOT|REPO)", re.I)


def kind_of_path(text: str):
    if re.search(r"\.jsonl?\b", text):
        return None
    if re.search(r"\.css\b", text):
        return 'css-class'
    if re.search(r"\.(md|txt)\b|docs/|README|AGENTS|CLAUDE\.md|ARCHITECTURE", text):
        return 'doc-wording'
    if re.search(r"fixtures?/|fixtures?['\"]", text):
        return 'fixture'
    if re.search(r"\.(py|ts|tsx|js|mjs|rs|sh|html|toml|ya?ml|sql)\b|(src|hub-ts|scripts|web|native|tools)/", text):
        return 'source-text'
    return 'unknown'


class Module:
    def __init__(self, tree: ast.Module):
        self.tree = tree
        self.roots = set()      # module-level names that hold the repository root
        self.tainted = {}       # module-level name -> kind (holds file text)
        self.helpers = {}       # module-level function -> kind (returns or reads file text)
        self.fixtures = {}      # fixture function -> kind
        for node in tree.body:
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                src = ast.unparse(node.value) if node.value is not None else ''
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                names = [n.id for t in targets for n in ast.walk(t) if isinstance(n, ast.Name)]
                if '__file__' in src or 'parents[' in src or any(ROOTISH.search(n) for n in names) and ('Path' in src or 'os.path' in src):
                    self.roots.update(names)
        for _ in range(2):
            for node in tree.body:
                if isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None:
                    k = self.read_kind_in(node.value)
                    if k and k != 'fixture':
                        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                        for t in targets:
                            for n in ast.walk(t):
                                if isinstance(n, ast.Name):
                                    self.tainted[n.id] = k
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith('test_'):
                    if STRICT:
                        rets = [r.value for r in ast.walk(node) if isinstance(r, ast.Return) and isinstance(r.value, ast.Call)]
                        direct = [r for r in rets if self.read_of(r) is not None]
                        k = self.read_of(direct[0])[0] if direct else None
                    else:
                        k = self.read_kind_in(node)
                    if k and k != 'fixture':
                        is_fixture = any('fixture' in ast.unparse(d) for d in node.decorator_list)
                        (self.fixtures if is_fixture else self.helpers)[node.name] = k

    def is_repo_path(self, expr_text: str) -> bool:
        if '__file__' in expr_text:
            return True
        for name in self.roots:
            if re.search(rf"\b{re.escape(name)}\b", expr_text):
                return True
        # A repository literal alone ('src/x.py') is not enough: tests build throwaway repositories with the same
        # layout under tmp_path. The path must be anchored on __file__ or a module-level root constant.
        return False

    def read_of(self, call: ast.Call):
        """(kind, path_text) when this call reads a repository file as text, else None."""
        f = call.func
        path = None
        if isinstance(f, ast.Attribute) and f.attr in ('read_text', 'read_bytes'):
            path = ast.unparse(f.value)
        elif isinstance(f, ast.Attribute) and f.attr == 'read' and isinstance(f.value, ast.Call) and isinstance(f.value.func, ast.Name) and f.value.func.id == 'open' and f.value.args:
            path = ast.unparse(f.value.args[0])
        elif isinstance(f, ast.Attribute) and f.attr == 'getsource':
            return ('source-text', ast.unparse(call))
        elif isinstance(f, ast.Name) and f.id in self.helpers:
            return (self.helpers[f.id], f.id + '()')
        if path is None:
            return None
        if not self.is_repo_path(path):
            k = kind_of_path(path)
            return ('fixture', path) if k == 'fixture' else None
        return (kind_of_path(path), path)

    def read_kind_in(self, node):
        parsed = set()
        if STRICT:
            for n in ast.walk(node):
                if isinstance(n, ast.Call) and isinstance(n.func, (ast.Attribute, ast.Name)) and getattr(n.func, 'attr', getattr(n.func, 'id', None)) in PARSERS:
                    for a in n.args:
                        for m in ast.walk(a):
                            parsed.add(id(m))
        for n in ast.walk(node):
            if id(n) in parsed:
                continue
            if isinstance(n, ast.Call):
                r = self.read_of(n)
                if r and r[0]:
                    return r[0]
            if isinstance(n, ast.Name) and n.id in self.tainted:
                return self.tainted[n.id]
        return None


TEXT_CALLS = {'search', 'match', 'fullmatch', 'findall', 'startswith', 'endswith', 'count', 'find', 'index'}


def text_assert(node) -> bool:
    for n in ast.walk(node):
        if isinstance(n, ast.Assert):
            for m in ast.walk(n.test):
                if isinstance(m, ast.Compare) and any(isinstance(o, (ast.In, ast.NotIn, ast.Eq, ast.NotEq)) for o in m.ops):
                    return True
                if isinstance(m, ast.Call) and isinstance(m.func, ast.Attribute) and m.func.attr in TEXT_CALLS:
                    return True
    return False


def shape_of(source: str, fn) -> str:
    """The function body's tokens with literals masked; the def line (and so the test's name) is left out."""
    lines = source.splitlines(keepends=True)
    body = ''.join(lines[fn.body[0].lineno - 1:fn.end_lineno]) if fn.body else ''
    out = []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(_dedent(body)).readline):
            if tok.type == tokenize.STRING or tok.type in (getattr(tokenize, 'FSTRING_START', -1), getattr(tokenize, 'FSTRING_MIDDLE', -1), getattr(tokenize, 'FSTRING_END', -1)):
                if not out or out[-1] != 'S':
                    out.append('S')
            elif tok.type == tokenize.NUMBER:
                out.append('N')
            elif tok.type in (tokenize.NAME, tokenize.OP):
                out.append(tok.string)
    except (tokenize.TokenError, IndentationError, SyntaxError):
        pass
    return ' '.join(out)


def _dedent(text: str) -> str:
    import textwrap
    return textwrap.dedent(text)


def detect(path: str, rel: str):
    source = open(path, encoding='utf-8').read()
    tree = ast.parse(source, filename=path)
    mod = Module(tree)
    out = []

    def visit_test(fn, prefix=''):
        flags = []
        kinds = {}
        params = [a.arg for a in fn.args.args]
        for p in params:
            if p in mod.fixtures:
                kinds.setdefault(mod.fixtures[p], (fn.lineno, f'fixture {p}'))
            if p == 'snapshot':
                flags.append({'kind': 'file-snapshot', 'line': fn.lineno, 'evidence': 'snapshot fixture'})
        parsed = set()
        in_assert = set()
        for n in ast.walk(fn):
            if STRICT and isinstance(n, ast.Call) and isinstance(n.func, (ast.Attribute, ast.Name)) and getattr(n.func, 'attr', getattr(n.func, 'id', None)) in PARSERS:
                for a in n.args:
                    for m in ast.walk(a):
                        parsed.add(id(m))
            if isinstance(n, ast.Assert):
                for m in ast.walk(n):
                    in_assert.add(id(m))
        for n in ast.walk(fn):
            if id(n) in parsed:
                continue
            if isinstance(n, ast.Call):
                r = mod.read_of(n)
                if r and r[0] and r[0] not in ('fixture', 'unknown'):
                    kinds.setdefault(r[0], (n.lineno, r[1][:60]))
            if isinstance(n, ast.Name) and n.id in mod.tainted:
                kinds.setdefault(mod.tainted[n.id], (n.lineno, n.id))
            if isinstance(n, ast.Constant) and isinstance(n.value, str) and re.search(r"class(Name)?\s*=|classList", n.value) and (not STRICT or id(n) in in_assert):
                if not any(f['kind'] == 'css-class' for f in flags):
                    flags.append({'kind': 'css-class', 'line': n.lineno, 'evidence': n.value[:60]})
            if isinstance(n, ast.Assert):
                for m in ast.walk(n.test):
                    if isinstance(m, ast.Compare) and any(isinstance(o, ast.Eq) for o in m.ops):
                        for side in [m.left, *m.comparators]:
                            whole = None
                            if isinstance(side, ast.Call):
                                r = mod.read_of(side)
                                if r and r[0]:
                                    whole = r
                            elif isinstance(side, ast.Name) and side.id in mod.tainted:
                                whole = (mod.tainted[side.id], side.id)
                            if whole and not any(f['kind'] == 'file-snapshot' for f in flags):
                                flags.append({'kind': 'file-snapshot', 'line': n.lineno, 'evidence': ast.unparse(side)[:80]})
        if text_assert(fn):
            for k, (ln, ev) in kinds.items():
                if k in ('unknown', 'fixture'):
                    continue
                if not any(f['kind'] == k for f in flags):
                    flags.append({'kind': k, 'line': ln, 'evidence': ev})
        out.append({'file': rel, 'name': prefix + fn.name, 'line': fn.lineno, 'endLine': fn.end_lineno, 'shape': shape_of(source, fn), 'flags': flags})

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith('test'):
            visit_test(node)
        elif isinstance(node, ast.ClassDef) and node.name.startswith('Test'):
            for sub in node.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)) and sub.name.startswith('test'):
                    visit_test(sub, node.name + '::')
    return out


def main():
    global STRICT
    argv = [a for a in sys.argv[1:] if a != '--strict']
    STRICT = '--strict' in sys.argv
    root = argv[0]
    d = argv[1] if len(argv) > 1 else 'tests'
    tests, errors = [], []
    files = sorted(f for f in os.listdir(os.path.join(root, d)) if f.startswith('test_') and f.endswith('.py'))
    for f in files:
        try:
            tests.extend(detect(os.path.join(root, d, f), f'{d}/{f}'))
        except SyntaxError as e:
            errors.append({'file': f, 'error': str(e)})
    counts = {}
    for t in tests:
        for fl in t['flags']:
            counts[fl['kind']] = counts.get(fl['kind'], 0) + 1
    json.dump({'strict': STRICT, 'files': len(files), 'tests': tests, 'flagged': sum(1 for t in tests if t['flags']), 'counts': counts, 'errors': errors}, sys.stdout)


if __name__ == '__main__':
    main()
