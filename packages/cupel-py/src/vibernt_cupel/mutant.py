"""Pytest plugin: serve one mutant through sys.meta_path and report test outcomes."""
import importlib.abc
import importlib.machinery
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

from .mutation_sites import apply

_SPEC = json.loads(Path(os.environ['CUPEL_MUTANT_SPEC']).read_text(encoding='utf-8')) if os.environ.get('CUPEL_MUTANT_SPEC') else None
_REPORT = os.environ.get('CUPEL_MUTANT_REPORT')


def _write_report(value):
    if _REPORT:
        with open(_REPORT, 'a', encoding='utf-8') as stream:
            stream.write(json.dumps(value) + '\n')


class _Loader(importlib.abc.Loader):
    def __init__(self, original, spec):
        self.original, self.spec = original, spec

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        Path(self.spec['seen']).touch()
        original = Path(self.spec['source']).read_text(encoding='utf-8')
        text = apply(original, SimpleNamespace(edits=self.spec['edits']))
        code = compile(text, self.spec['source'], 'exec')
        exec(code, module.__dict__)


class _Finder(importlib.abc.MetaPathFinder):
    def __init__(self, spec):
        self.spec = spec

    def find_spec(self, fullname, path=None, target=None):
        found = importlib.machinery.PathFinder.find_spec(fullname, path, target)
        if found and found.origin and os.path.realpath(found.origin) == os.path.realpath(self.spec['source']):
            found.loader = _Loader(found.loader, self.spec)
            return found
        return None


if _SPEC:
    sys.meta_path.insert(0, _Finder(_SPEC))


def pytest_runtest_logstart(nodeid, location):
    _write_report({'nodeid': nodeid, 'event': 'start'})


def pytest_runtest_logreport(report):
    _write_report({'nodeid': report.nodeid, 'when': report.when, 'failed': report.failed, 'passed': report.passed})
