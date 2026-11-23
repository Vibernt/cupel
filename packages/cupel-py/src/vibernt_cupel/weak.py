"""Static assertion checks for pytest tests (test-quality audit, phase 3).

The same rules as the JavaScript and Rust checks:
- ``no-assertion`` only when certain: no ``assert``, no ``raise``, no
  ``pytest.raises``/``warns``/``fail``, no ``self.assert*``/``self.fail``, no
  mock ``assert_*`` call, no check-named call, no same-module helper that
  checks, and no call into a test-helper module. Otherwise nothing is reported.
- ``tautology``: ``assert True``, ``assert x == x``, ``self.assertEqual(x, x)``,
  ``self.assertTrue(True)``.
"""
import ast
import re

CHECK_CALL = re.compile(r'^(?:assert|check|verify|expect|ensure|must|validate|fail)', re.I)
HELPER_MODULE = re.compile(r'(?:^|\.)(?:conftest|[^.]*(?:test|helper|fixture|support|util|harness|common)[^.]*)$', re.I)
EQUAL_METHODS = {'assertEqual', 'assertEquals', 'assertIs', 'assertDictEqual', 'assertListEqual', 'assertSequenceEqual', 'assertCountEqual'}


def _same(a, b):
    return ast.dump(a, include_attributes=False) == ast.dump(b, include_attributes=False)


def _constant_true(node):
    return isinstance(node, ast.Constant) and node.value in (True, 1) and not isinstance(node.value, str)


class Module:
    def __init__(self, tree):
        self.functions = {}
        self.helpers = set()
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.functions.setdefault(node.name, []).append(node)
            elif isinstance(node, ast.ClassDef):
                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        self.functions.setdefault(item.name, []).append(item)
            elif isinstance(node, ast.ImportFrom):
                # Names from a helper-like module (conftest, tests.helpers, .utils), or
                # from a bare relative package (`from . import x`), may check inside.
                module = node.module or ''
                if HELPER_MODULE.search(module) or (node.level and not module):
                    for alias in node.names:
                        self.helpers.add(alias.asname or alias.name)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if HELPER_MODULE.search(alias.name):
                        self.helpers.add((alias.asname or alias.name).split('.')[0])


def _call_name(call):
    f = call.func
    if isinstance(f, ast.Name):
        return f.id, None
    if isinstance(f, ast.Attribute):
        base = f.value
        root = base
        while isinstance(root, ast.Attribute):
            root = root.value
        return f.attr, root.id if isinstance(root, ast.Name) else None
    return None, None


def checks(fn, mod, seen=None, depth=0):
    """True, False or 'unknown'."""
    seen = seen if seen is not None else set()
    unknown = False
    for node in ast.walk(fn):
        if node is fn:
            continue
        if isinstance(node, (ast.Assert, ast.Raise)):
            return True
        if isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                if isinstance(item.context_expr, ast.Call):
                    name, _ = _call_name(item.context_expr)
                    if name in ('raises', 'warns', 'assertRaises', 'assertRaisesRegex', 'assertWarns', 'deprecated_call'):
                        return True
        if not isinstance(node, ast.Call):
            continue
        name, root = _call_name(node)
        if not name:
            continue
        if isinstance(node.func, ast.Attribute):
            if name.startswith('assert') or name in ('fail', 'raises', 'warns', 'approx', 'skip', 'xfail'):
                return True
            if root in mod.helpers:
                unknown = True
            continue
        if CHECK_CALL.match(name):
            return True
        if name in mod.helpers:
            unknown = True
            continue
        if name in mod.functions and name not in seen:
            if depth >= 4:
                unknown = True
                continue
            seen.add(name)
            for helper in mod.functions[name]:
                inner = checks(helper, mod, seen, depth + 1)
                if inner is True:
                    return True
                if inner == 'unknown':
                    unknown = True
    return 'unknown' if unknown else False


def tautologies(fn):
    lines = []
    for node in ast.walk(fn):
        if isinstance(node, ast.Assert):
            test = node.test
            if _constant_true(test):
                lines.append(node.lineno)
            elif isinstance(test, ast.Compare) and len(test.ops) == 1 and isinstance(test.ops[0], (ast.Eq, ast.Is)) and _same(test.left, test.comparators[0]):
                lines.append(node.lineno)
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            name = node.func.attr
            if name in EQUAL_METHODS and len(node.args) >= 2 and _same(node.args[0], node.args[1]):
                lines.append(node.lineno)
            elif name == 'assertTrue' and node.args and _constant_true(node.args[0]):
                lines.append(node.lineno)
    return sorted(set(lines))


def weak_flags(tree, fn):
    mod = Module(tree)
    out = [('tautology', line) for line in tautologies(fn)]
    # A fixture-only test (a body of `pass` or a docstring) still checks nothing.
    if checks(fn, mod) is False:
        out.insert(0, ('no-assertion', fn.lineno))
    return out
