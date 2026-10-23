"""Lazy AST mutation sites. Only selected sites construct full mutated source text."""
import ast
import hashlib
import io
import json
import tokenize
from dataclasses import dataclass

OPERATORS = ('cmp-flip', 'boundary', 'bool-literal', 'logical', 'negate-cond', 'remove-not', 'arith', 'return-value', 'remove-call', 'body-replace')
CMP = {'==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>'}
BOUNDARY = {'<': '<=', '<=': '<', '>': '>=', '>=': '>'}
ARITH = {'+': '-', '-': '+', '*': '/', '/': '*'}


@dataclass(frozen=True)
class Site:
    id: str
    source: str
    line: int
    col: int
    operator: str
    edits: tuple  # byte offsets, end exclusive, UTF-8 replacement bytes
    function_key: str = ''
    function_name: str = ''
    start_line: int = 0
    end_line: int = 0
    variant: int = 0


def apply(text, site):
    raw = text.encode('utf-8')
    for start, end, replacement in sorted(site.edits, reverse=True):
        raw = raw[:start] + replacement.encode('utf-8') + raw[end:]
    return raw.decode('utf-8')


def generate(source, text, functions_only=False):
    """Yield descriptors in AST visit order, including invalid sites for the caller to check."""
    tree = ast.parse(text, filename=source)
    raw = text.encode('utf-8')
    starts = [0]
    for line in raw.splitlines(keepends=True):
        starts.append(starts[-1] + len(line))
    at = lambda line, col: starts[line - 1] + col
    span = lambda node: (at(node.lineno, node.col_offset), at(node.end_lineno, node.end_col_offset))
    token_list = list(tokenize.tokenize(io.BytesIO(raw).readline))
    tokens = [(at(t.start[0], len(t.line[:t.start[1]].encode('utf-8'))), at(t.end[0], len(t.line[:t.end[1]].encode('utf-8'))), t.string)
              for t in token_list if t.type not in (tokenize.ENCODING, tokenize.ENDMARKER) and t.start[0] and t.end[0]]
    seen = set()
    seen_edits = set()

    def same_lines(start, end, value):
        # Preserve every original newline, including in a multi-line return or call.
        return value + '\n' * raw[start:end].count(b'\n')

    def make(operator, start, edits):
        line = raw[:start].count(b'\n') + 1
        col = start - (raw.rfind(b'\n', 0, start) + 1) + 1
        signature = json.dumps([(a - start, b - a, c) for a, b, c in edits], separators=(',', ':'))
        digest = hashlib.sha256(signature.encode()).hexdigest()[:8]
        mid = f'{source}:{line}:{col}:{operator}:{digest}'
        edit_key = tuple(edits)
        if mid in seen or edit_key in seen_edits:
            return None
        seen.add(mid)
        seen_edits.add(edit_key)
        return Site(mid, source, line, col, operator, tuple(edits))

    def operator_token(left, right, names):
        lo, hi = span(left)[1], span(right)[0]
        return next(((a, b, value) for a, b, value in tokens if lo <= a < hi and value in names), None)

    def logging_call(node):
        if not isinstance(node, ast.Call):
            return False
        fn = node.func
        return isinstance(fn, ast.Name) and fn.id == 'print' or isinstance(fn, ast.Attribute) and isinstance(fn.value, ast.Name) and fn.value.id in ('logging', 'logger')

    def body_sites(node):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or node.name == '__init__':
            return
        if any((isinstance(dec, ast.Name) and dec.id == 'abstractmethod') or
               (isinstance(dec, ast.Attribute) and dec.attr == 'abstractmethod') for dec in node.decorator_list):
            return
        if not node.body:
            return
        first, last = node.body[0], node.body[-1]
        start, end = span(first)[0], span(last)[1]
        key = f'{source}:{node.lineno}:{node.col_offset + 1}'
        for variant, replacement in enumerate(('pass', 'return None')):
            site = make('body-replace', start, [(start, end, same_lines(start, end, replacement))])
            if site:
                yield Site(site.id, source, site.line, site.col, site.operator, site.edits,
                           key, node.name, first.lineno, last.end_lineno, variant)

    def visit(node, in_logging=False):
        yield from body_sites(node)
        if functions_only:
            for child in ast.iter_child_nodes(node):
                yield from visit(child, in_logging)
            return
        if logging_call(node):
            in_logging = True
        if not in_logging:
            candidates = []
            if isinstance(node, ast.Compare):
                operands = [node.left, *node.comparators]
                for left, right in zip(operands, operands[1:]):
                    found = operator_token(left, right, CMP)
                    if found:
                        a, b, op = found
                        candidates.append(('cmp-flip', a, [(a, b, CMP[op])]))
                        if op in BOUNDARY:
                            candidates.append(('boundary', a, [(a, b, BOUNDARY[op])]))
            elif isinstance(node, ast.Constant) and isinstance(node.value, bool):
                a, b = span(node)
                candidates.append(('bool-literal', a, [(a, b, 'False' if node.value else 'True')]))
            elif isinstance(node, ast.BoolOp):
                replacement = 'or' if isinstance(node.op, ast.And) else 'and'
                for left, right in zip(node.values, node.values[1:]):
                    found = operator_token(left, right, ('and', 'or'))
                    if found:
                        a, b, _ = found
                        candidates.append(('logical', a, [(a, b, replacement)]))
            elif isinstance(node, (ast.If, ast.While)):
                a, b = span(node.test)
                candidates.append(('negate-cond', a, [(a, a, 'not ('), (b, b, ')')]))
            elif isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
                a, _ = span(node)
                found = next(((s, e) for s, e, value in tokens if s == a and value == 'not'), None)
                if found:
                    candidates.append(('remove-not', a, [(a, found[1], '')]))
            elif isinstance(node, ast.BinOp):
                found = operator_token(node.left, node.right, ARITH)
                if found:
                    a, b, op = found
                    candidates.append(('arith', a, [(a, b, ARITH[op])]))
            elif isinstance(node, ast.Return) and node.value is not None:
                a, b = span(node.value)
                if isinstance(node.value, ast.Constant) and node.value.value is None:
                    pass
                else:
                    replacement = 'False' if isinstance(node.value, ast.Constant) and node.value.value is True else 'None'
                    candidates.append(('return-value', span(node)[0], [(a, b, same_lines(a, b, replacement))]))
            elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and not logging_call(node.value):
                a, b = span(node)
                candidates.append(('remove-call', a, [(a, b, same_lines(a, b, 'pass'))]))
            for operator, start, edits in candidates:
                site = make(operator, start, edits)
                if site:
                    yield site
        for child in ast.iter_child_nodes(node):
            yield from visit(child, in_logging)

    yield from visit(tree)
