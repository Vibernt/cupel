"""Python mapping of K1: lexical code tokens, with docstring tokens excluded.

A line is coverable if a non-whitespace character belongs to a Python token
other than a comment, indentation, newline, encoding marker, or a docstring
expression. Multiline strings count on each line with non-whitespace content.
Coverage uses sys.monitoring LINE events and is intersected with this set;
Python does not expose JavaScript-style character coverage ranges.
"""
import ast
import hashlib
import codecs
import io
import tokenize
from pathlib import Path


def line_set(lines):
    numbers = sorted(set(lines))
    parts = []
    for n in numbers:
        if parts and n == parts[-1][1] + 1:
            parts[-1][1] = n
        else:
            parts.append([n, n])
    return ','.join(str(a) if a == b else f'{a}-{b}' for a, b in parts)


def coverable(text):
    tree = ast.parse(text)
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                docstrings.add((first.value.lineno, first.value.col_offset))
    out = set()
    ignored = {tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT,
               tokenize.DEDENT, tokenize.ENDMARKER, tokenize.ENCODING}
    for token in tokenize.generate_tokens(io.StringIO(text).readline):
        if token.type in ignored or token.start in docstrings:
            continue
        for line in range(token.start[0], token.end[0] + 1):
            fragment = token.string.split('\n')[line - token.start[0]] if '\n' in token.string else token.string
            if fragment.strip():
                out.add(line)
    return out


def source_record(path):
    raw = Path(path).read_bytes()
    encoding, _ = tokenize.detect_encoding(io.BytesIO(raw).readline)
    return {'coverable': line_set(coverable(raw.decode(encoding))),
            'hash': 'sha256:' + hashlib.sha256(raw).hexdigest()}
