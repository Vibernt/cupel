"""Test shapes and strict source-text pin detection, adapted from S6."""
import ast
import io
import re
import tokenize
from pathlib import Path
from .brittleness import flags_for


def _fn(source, line):
    tree = ast.parse(source)
    return next((n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.lineno == line), None)


def shape(source, fn):
    body = ''.join(source.splitlines(keepends=True)[fn.lineno - 1:fn.end_lineno])
    tokens = []
    for token in tokenize.generate_tokens(io.StringIO(body).readline):
        if token.type == tokenize.STRING or token.type in (getattr(tokenize, 'FSTRING_START', -1), getattr(tokenize, 'FSTRING_MIDDLE', -1), getattr(tokenize, 'FSTRING_END', -1)):
            tokens.append('S')
        elif token.type == tokenize.NUMBER:
            tokens.append('N')
        elif token.type in (tokenize.NAME, tokenize.OP):
            tokens.append(token.string)
    hashes = set()
    for i in range(len(tokens) - 3):
        value = 2166136261
        for byte in ' '.join(tokens[i:i + 4]).encode('utf-8'):
            value = ((value ^ byte) * 16777619) & 0xffffffff
        hashes.add(value)
    return sorted(hashes)


def findings(source, fn, patterns):
    out = [(kind, line, False) for kind, line in flags_for(source, fn)]
    lines = source.splitlines()
    body = '\n'.join(lines[fn.lineno - 1:fn.end_lineno])
    for pattern in patterns:
        if pattern.get('language', 'python').lower() != 'python':
            continue
        try:
            match = re.search(pattern['pattern'], body, re.MULTILINE)
        except re.error as error:
            raise ValueError(f'invalid brittleness pattern {pattern["pattern"]!r}: {error}') from error
        if match:
            out.append((pattern['kind'], fn.lineno + body[:match.start()].count('\n'), pattern.get('deliberate', False)))
    return sorted(set(out))


def inspect(root, tests, patterns):
    shapes, brittle = {}, []
    cache = {}
    for test in tests:
        path = test['file']
        if path not in cache:
            cache[path] = Path(root, path).read_text(encoding='utf-8')
        source = cache[path]
        fn = _fn(source, test['line'])
        if fn is None:
            raise ValueError(f'cannot locate test definition {test["id"]} at line {test["line"]}')
        shapes[test.get('unit', test['id'])] = shape(source, fn)
        for kind, line, deliberate in findings(source, fn, patterns):
            finding = {'test': test['id'], 'kind': kind, 'line': line}
            if deliberate:
                finding['deliberate'] = True
            brittle.append(finding)
    return shapes, sorted(brittle, key=lambda x: (x['test'], x['kind'], x['line']))
