"""Source line measurement for the small sequential unittest fixture."""
from __future__ import annotations

import tokenize
import unittest
from pathlib import Path


class TraceCoverage:
    def __init__(self, root: Path, source_root: Path):
        self.root = root
        self.source_root = source_root.resolve()
        self.active_test: unittest.TestCase | None = None
        self.covered_by_test: dict[str, dict[str, set[int]]] = {}
        self.setup_all: dict[str, set[int]] = {}
        self.setup_by_file: dict[str, dict[str, set[int]]] = {}

    def __call__(self, frame, event, arg):
        if event != "line":
            return self
        path = Path(frame.f_code.co_filename).resolve()
        try:
            relative = path.relative_to(self.source_root).as_posix()
        except ValueError:
            return self
        source = f"src/{relative}"
        line = frame.f_lineno
        if self.active_test is None:
            if line < 1:
                return self
            test_directory = (self.root / "tests").resolve()
            caller = frame.f_back
            while caller is not None:
                caller_path = Path(caller.f_code.co_filename).resolve()
                try:
                    caller_path.relative_to(test_directory)
                    test_file = caller_path.relative_to(self.root).as_posix()
                except ValueError:
                    caller = caller.f_back
                    continue
                if caller_path.suffix == ".py":
                    self.setup_by_file.setdefault(test_file, {}).setdefault(source, set()).add(line)
                    break
                caller = caller.f_back
            else:
                self.setup_all.setdefault(source, set()).add(line)
        else:
            from identity import test_id

            identifier = test_id(self.active_test)
            self.covered_by_test.setdefault(identifier, {}).setdefault(source, set()).add(line)
        return self

    def startTest(self, test):
        self.active_test = test

    def stopTest(self, test):
        self.active_test = None


def line_set(numbers):
    values = sorted(numbers)
    if not values:
        return ""
    ranges = []
    start = previous = values[0]
    for value in values[1:]:
        if value == previous + 1:
            previous = value
            continue
        ranges.append(str(start) if start == previous else f"{start}-{previous}")
        start = previous = value
    ranges.append(str(start) if start == previous else f"{start}-{previous}")
    return ",".join(ranges)


def coverable_lines(path: Path):
    coverable = set()
    with path.open("r", encoding="utf-8") as source_file:
        for token in tokenize.generate_tokens(source_file.readline):
            if token.type in {tokenize.ENCODING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT,
                              tokenize.DEDENT, tokenize.COMMENT, tokenize.ENDMARKER}:
                continue
            if token.type == tokenize.STRING:
                for offset, text in enumerate(token.string.splitlines()):
                    if text.strip():
                        coverable.add(token.start[0] + offset)
            elif token.string.strip():
                coverable.update(range(token.start[0], token.end[0] + 1))
    return coverable
