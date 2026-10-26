#!/usr/bin/env python3
"""Measured adapter for a small sequential Python unittest project."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import unittest
from pathlib import Path

from coverage import TraceCoverage, coverable_lines, line_set
from identity import discover, tags_for, test_file, test_id, test_name


class StatusResult(unittest.TestResult):
    def __init__(self, coverage):
        super().__init__()
        self.coverage = coverage
        self.statuses = {}
        self.durations_ms = {}

    def startTest(self, test):
        super().startTest(test)
        self.coverage.startTest(test)
        self._started = time.perf_counter()

    def stopTest(self, test):
        self.coverage.stopTest(test)
        self.durations_ms[test] = round((time.perf_counter() - self._started) * 1000)
        super().stopTest(test)

    def addSuccess(self, test):
        super().addSuccess(test)
        self.statuses[test] = "passed"

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.statuses[test] = "failed"

    def addError(self, test, err):
        super().addError(test, err)
        self.statuses[test] = "failed"

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self.statuses[test] = "skipped"


def collect(root, requested=None):
    source_root = root / "src"
    coverage = TraceCoverage(root, source_root)
    sys.settrace(coverage)
    try:
        # Trace begins before discovery to record module-load setup coverage.
        cases, source_root = discover(root)
        by_id = {test_id(case): case for case in cases}
        if requested is not None:
            if len(set(requested)) != len(requested):
                raise RuntimeError("duplicate test id in selection")
            missing = sorted(set(requested) - by_id.keys())
            if missing:
                raise RuntimeError("unknown test id(s): " + ", ".join(missing))
            cases = [by_id[identifier] for identifier in sorted(requested)]
        if not cases:
            raise RuntimeError("selection must contain at least one test")
        result = StatusResult(coverage)
        unittest.TestSuite(cases).run(result)
    finally:
        sys.settrace(None)
    if len(result.statuses) != len(cases):
        raise RuntimeError("unittest did not report every selected test")

    sources = {}
    for path in sorted(source_root.rglob("*.py")):
        relative = f"src/{path.relative_to(source_root).as_posix()}"
        sources[relative] = {
            "coverable": line_set(coverable_lines(path)),
            "hash": hashlib.sha256(path.read_bytes()).hexdigest(),
        }

    tests = []
    by_test = {}
    for case in cases:
        identifier = test_id(case)
        status = result.statuses[case]
        tests.append({"id": identifier, "file": test_file(case), "name": test_name(case),
                      "status": status, "runStatuses": [status],
                      "durationsMs": [result.durations_ms[case]], "tags": tags_for(case)})
        by_test[identifier] = {source: line_set(lines) for source, lines in
                               sorted(coverage.covered_by_test.get(identifier, {}).items())}

    setup = {}
    for file in sorted({test_file(case) for case in cases}):
        lines_by_source = {source: set(lines) for source, lines in coverage.setup_all.items()}
        for source, lines in coverage.setup_by_file.get(file, {}).items():
            lines_by_source.setdefault(source, set()).update(lines)
        setup[file] = {source: line_set(lines) for source, lines in sorted(lines_by_source.items())}
    return {"spec": "cupel-spec/1", "kind": "input",
            "runtime": {"name": "python", "version": sys.version.split()[0]},
            "sources": sources, "tests": tests,
            "coverage": {"granularity": "test", "byTest": by_test, "setup": setup}}


def run(args):
    if args.recheck:
        raise RuntimeError("--recheck is unsupported: no fresh-process recheck implementation")
    if args.runs != 1:
        raise RuntimeError("--runs currently supports exactly 1 measured run")
    root = args.root.resolve()
    if args.list_tests or args.tags:
        cases, _ = discover(root)
        if args.tags:
            return [{"id": test_id(case), "tags": tags_for(case)} for case in cases]
        return [{"id": test_id(case), "file": test_file(case), "name": test_name(case),
                 "tags": tags_for(case)} for case in cases]
    return collect(root, args.select)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--recheck", action="append", default=[])
    parser.add_argument("--list", action="store_true", dest="list_tests")
    parser.add_argument("--select", nargs="+", metavar="TEST_ID")
    parser.add_argument("--boundaries", action="store_true")
    parser.add_argument("--tags", action="store_true")
    args = parser.parse_args()
    try:
        document = run(args)
        rendered = json.dumps(document, indent=2)
        if args.out and not (args.list_tests or args.tags):
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(rendered + "\n", encoding="utf-8")
        else:
            print(rendered)
        return 0
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
