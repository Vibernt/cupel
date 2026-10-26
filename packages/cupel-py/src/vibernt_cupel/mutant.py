"""Pytest plugin: serve one mutant through sys.meta_path and report test outcomes."""
import importlib.abc
import importlib.machinery
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

from .mutation_sites import apply
from .mutation_source import SourceChangedError, SourceFacts

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
        try:
            facts = SourceFacts(self.spec['root'], {'sources': {self.spec['source']: {'hash': self.spec['hash']}}}, require_hash=True)
            fact = facts.retain(self.spec['source'])
            if (fact.path.real != self.spec['real'] or fact.path.root_real != self.spec['root_real'] or
                    fact.path.device != self.spec['device'] or fact.path.inode != self.spec['inode']):
                raise SourceChangedError(self.spec['source'], 'path differs from parent source fact')
            facts.assert_fresh(self.spec['source'])
        except SourceChangedError:
            _write_report({'event': 'source-changed'})
            raise
        text = apply(fact.text, SimpleNamespace(edits=self.spec['edits']))
        code = compile(text, fact.path.real, 'exec')
        Path(self.spec['seen']).touch()
        exec(code, module.__dict__)


class _Finder(importlib.abc.MetaPathFinder):
    def __init__(self, spec):
        self.spec = spec

    def find_spec(self, fullname, path=None, target=None):
        found = importlib.machinery.PathFinder.find_spec(fullname, path, target)
        if found and found.origin and os.path.realpath(found.origin) == self.spec['real']:
            found.loader = _Loader(found.loader, self.spec)
            return found
        return None


if _SPEC:
    sys.meta_path.insert(0, _Finder(_SPEC))


def pytest_runtest_logstart(nodeid, location):
    _write_report({'nodeid': nodeid, 'event': 'start'})


def pytest_runtest_logreport(report):
    _write_report({'nodeid': report.nodeid, 'when': report.when, 'failed': report.failed, 'passed': report.passed})
