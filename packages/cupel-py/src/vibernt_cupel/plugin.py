"""pytest entry point. Importing this module does not import pytest."""
import ast
import json
import os
import subprocess
import sys
from pathlib import Path

from .monitor import Monitor

_ROOT = Path(os.environ.get('CUPEL_ROOT', os.getcwd())).resolve()
_OUT = os.environ.get('CUPEL_RESULT')
_MODE = os.environ.get('CUPEL_MODE', 'run')
_SOURCES = set(json.loads(os.environ.get('CUPEL_SOURCES', '[]')))
_MON = None
_TESTS = {}
_COLLECTED = []
_SPAWNED = set()
_ORIG_POPEN = subprocess.Popen.__init__
_ORIG_EXEC = {}
_AST_CACHE = {}


def _is_python(program):
    if isinstance(program, os.PathLike):
        program = os.fspath(program)
    if isinstance(program, bytes):
        program = os.fsdecode(program)
    if not isinstance(program, str):
        return False
    return os.path.realpath(program) == os.path.realpath(sys.executable) or os.path.basename(program).lower().startswith(('python', 'pypy'))


def _popen(self, args, *pos, **kw):
    program = kw.get('executable')
    if program is None:
        command = kw.get('args', args)
        if isinstance(command, (str, bytes)):
            program = command.split()[0] if command else None
        else:
            try:
                program = command[0]
            except (TypeError, IndexError, KeyError):
                program = None
    if _is_python(program) and _MON and _MON.current in _TESTS:
        _SPAWNED.add(_MON.current)
    return _ORIG_POPEN(self, args, *pos, **kw)


def _exec_wrapper(name, original):
    def wrapped(*args, **kwargs):
        if args and _is_python(args[0]) and _MON and _MON.current in _TESTS:
            _SPAWNED.add(_MON.current)
        return original(*args, **kwargs)
    wrapped.__name__ = name
    return wrapped


def pytest_load_initial_conftests(early_config, parser, args):
    _begin()


def _begin():
    global _MON
    if _MODE == 'list' or _MON is not None:
        return
    _MON = Monitor(_ROOT, _SOURCES)
    _MON.start()
    subprocess.Popen.__init__ = _popen
    for name in dir(os):
        if name.startswith('exec') and callable(getattr(os, name)):
            original = getattr(os, name)
            _ORIG_EXEC[name] = original
            setattr(os, name, _exec_wrapper(name, original))


def pytest_configure(config):
    global _MON
    for tier in ('critical', 'standard', 'minor'):
        config.addinivalue_line('markers', f'cupel_{tier}: Cupel {tier} tier')
    if _MODE != 'list':
        _begin()
        import pytest

        class BroadFixtureBoundary:
            @pytest.hookimpl(hookwrapper=True, tryfirst=True)
            def pytest_fixture_setup(self, fixturedef, request):
                if fixturedef.scope == 'function':
                    yield
                    return
                prior = _MON.current
                node_path = getattr(request.node, 'path', None)
                try:
                    file = Path(node_path).resolve().relative_to(_ROOT).as_posix() if node_path and Path(node_path).is_file() else 'global'
                except ValueError:
                    file = 'global'
                _MON.switch('fixture:' + file)
                try:
                    yield
                finally:
                    _MON.switch(prior)

        config.pluginmanager.register(BroadFixtureBoundary(), 'vibernt-cupel-broad-fixtures')

        class CollectionBoundary:
            @pytest.hookimpl(hookwrapper=True, tryfirst=True)
            def pytest_make_collect_report(self, collector):
                path = getattr(collector, 'path', None)
                if path is None or not Path(path).is_file() or Path(path).suffix != '.py':
                    yield
                    return
                try:
                    file = Path(path).resolve().relative_to(_ROOT).as_posix()
                except ValueError:
                    yield
                    return
                prior = _MON.current
                _MON.switch('collect:' + file)
                try:
                    yield
                finally:
                    _MON.switch(prior)

        config.pluginmanager.register(CollectionBoundary(), 'vibernt-cupel-collection-boundaries')


def _file(item):
    return Path(item.path).resolve().relative_to(_ROOT).as_posix()


def _name_parts(nodeid):
    suffix = nodeid.split('::', 1)[1]
    parts, start, depth = [], 0, 0
    for index, char in enumerate(suffix):
        if char == '[':
            depth += 1
        elif char == ']':
            depth = max(0, depth - 1)
        elif char == ':' and depth == 0 and suffix[index:index + 2] == '::':
            parts.append(suffix[start:index])
            start = index + 2
    parts.append(suffix[start:])
    return [part for part in parts if part]


def _record(item):
    path = _file(item)
    pieces = _name_parts(item.nodeid)
    name = ' > '.join(pieces)
    test_id = f'{path}::{name}'
    location = getattr(item, 'function', None)
    code_line = location.__code__.co_firstlineno if location is not None else item.location[1] + 1
    if path not in _AST_CACHE:
        _AST_CACHE[path] = ast.parse(Path(_ROOT, path).read_text(encoding='utf-8'))
    functions = [n for n in ast.walk(_AST_CACHE[path]) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
    fn = next((n for n in functions if n.lineno == code_line or any(d.lineno == code_line for d in n.decorator_list)), None)
    if fn is None:
        raise RuntimeError(f'cannot find pytest definition {item.nodeid} at line {code_line}')
    line = fn.lineno
    tags = sorted({m.name[6:] for m in item.iter_markers() if m.name in ('cupel_critical', 'cupel_standard', 'cupel_minor')})
    return {'id': test_id, 'file': path, 'name': name, 'line': line, 'nodeid': item.nodeid,
            'tags': tags, 'status': 'passed', 'duration': 0.0}


def pytest_collection_finish(session):
    global _COLLECTED
    _COLLECTED = [_record(item) for item in session.items]
    if _MODE != 'list':
        _TESTS.update({row['id']: row for row in _COLLECTED})
    if _MODE == 'list':
        session.items[:] = []


def pytest_runtest_setup(item):
    if _MON:
        _MON.switch(_record(item)['id'])


def pytest_runtest_logreport(report):
    if not _MON:
        return
    row = next((r for r in _COLLECTED if r['nodeid'] == report.nodeid), None)
    if row is None:
        return
    row['duration'] += report.duration
    if report.failed:
        row['status'] = 'failed'
    elif report.skipped and row['status'] != 'failed':
        row['status'] = 'skipped'
    if report.when == 'teardown':
        _MON.switch('between')


def pytest_sessionfinish(session, exitstatus):
    if _MON:
        _MON.close()
        subprocess.Popen.__init__ = _ORIG_POPEN
        for name, original in _ORIG_EXEC.items():
            setattr(os, name, original)
    if not _OUT:
        return
    rows = _COLLECTED
    result = {'tests': rows, 'spawns': sorted(_SPAWNED),
              'buckets': {name: sorted(lines) for name, lines in (_MON.buckets if _MON else {}).items()}}
    Path(_OUT).write_text(json.dumps(result), encoding='utf-8')
