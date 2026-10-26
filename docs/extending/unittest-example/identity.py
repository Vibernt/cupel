"""unittest discovery, stable Cupel IDs, and short-description tier tags."""
from __future__ import annotations

import re
import unittest
from pathlib import Path

TIER_TAG = re.compile(r"\[([^\]]+)\]")


def iter_cases(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from iter_cases(item)
        else:
            yield item


def tags_for(case):
    description = case.shortDescription() or ""
    return [match.group(1) for match in TIER_TAG.finditer(description)]


def test_name(case):
    base = f"{case.__class__.__qualname__}.{case._testMethodName}"
    tags = tags_for(case)
    return f"{base} {' '.join(f'[{tag}]' for tag in tags)}" if tags else base


def test_id(case):
    relative_file = Path(*case.__class__.__module__.split(".")).with_suffix(".py").as_posix()
    return f"{relative_file}::{test_name(case)}"


def test_file(case):
    return test_id(case).split("::", 1)[0]


def discover(root):
    test_root = root / "tests"
    source_root = root / "src"
    if not test_root.is_dir() or not source_root.is_dir():
        raise RuntimeError("expected project layout with tests/ and src/ directories")
    loader = unittest.defaultTestLoader
    suite = loader.discover(str(test_root), pattern="test*.py", top_level_dir=str(root))
    if loader.errors:
        raise RuntimeError("unittest discovery failed: " + "; ".join(loader.errors))
    cases = list(iter_cases(suite))
    if not cases:
        raise RuntimeError("unittest discovered no tests")
    if any(case.__class__.__name__ == "_FailedTest" for case in cases):
        raise RuntimeError("unittest discovery produced an import failure")
    return sorted(cases, key=test_id), source_root
