"""Strict S6 Python brittleness detector core, copied into the package.

No pytest dependency; see plans/spikes/s6/detect_py.py for the measured seed.
"""
import ast
import re

STRICT = True
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




def flags_for(source, fn):
    tree = ast.parse(source)
    mod = Module(tree)
    flags = []
    kinds = {}
    params = [a.arg for a in fn.args.args]
    for param in params:
        if param in mod.fixtures:
            kinds.setdefault(mod.fixtures[param], (fn.lineno, f'fixture {param}'))
        if param == 'snapshot':
            flags.append(('file-snapshot', fn.lineno))
    parsed = set()
    in_assert = set()
    for node in ast.walk(fn):
        if isinstance(node, ast.Call) and isinstance(node.func, (ast.Attribute, ast.Name)) and getattr(node.func, 'attr', getattr(node.func, 'id', None)) in PARSERS:
            for arg in node.args:
                for child in ast.walk(arg):
                    parsed.add(id(child))
        if isinstance(node, ast.Assert):
            for child in ast.walk(node):
                in_assert.add(id(child))
    for node in ast.walk(fn):
        if id(node) in parsed:
            continue
        if isinstance(node, ast.Call):
            read = mod.read_of(node)
            if read and read[0] not in ('fixture', 'unknown', None):
                kinds.setdefault(read[0], (node.lineno, read[1]))
        if isinstance(node, ast.Name) and node.id in mod.tainted:
            kinds.setdefault(mod.tainted[node.id], (node.lineno, node.id))
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) in in_assert and re.search(r'class(Name)?\s*=|classList', node.value):
            flags.append(('css-class', node.lineno))
        if isinstance(node, ast.Assert):
            for child in ast.walk(node.test):
                if isinstance(child, ast.Compare) and any(isinstance(op, ast.Eq) for op in child.ops):
                    for side in [child.left, *child.comparators]:
                        whole = mod.read_of(side) if isinstance(side, ast.Call) else (mod.tainted.get(side.id), side.id) if isinstance(side, ast.Name) and side.id in mod.tainted else None
                        if whole and whole[0]:
                            flags.append(('file-snapshot', node.lineno))
                            break
    if text_assert(fn):
        for kind, (line, _) in kinds.items():
            if kind not in ('fixture', 'unknown', None):
                flags.append((kind, line))
    return sorted(set(flags))
