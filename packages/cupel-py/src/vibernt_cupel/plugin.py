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
    try:
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
    except Exception as error:
        _warn('subprocess', error)
    return _ORIG_POPEN(self, args, *pos, **kw)


def _exec_wrapper(name, original):
    def wrapped(*args, **kwargs):
        try:
            if args and _is_python(args[0]) and _MON and _MON.current in _TESTS:
                _SPAWNED.add(_MON.current)
        except Exception as error:
            _warn(name, error)
        return original(*args, **kwargs)
    wrapped.__name__ = name
    return wrapped


def pytest_load_initial_conftests(early_config, parser, args):
    try:
        _begin()
    except Exception as error:
        _warn('initialisation', error)


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
    try:
        for tier in ('critical', 'standard', 'minor'):
            config.addinivalue_line('markers', f'cupel_{tier}: Cupel {tier} tier')
        if _MODE == 'list':
            return
        _begin()
        if _MON is None:
            return
        import pytest

        class BroadFixtureBoundary:
            @pytest.hookimpl(hookwrapper=True, tryfirst=True)
            def pytest_fixture_setup(self, fixturedef, request):
                prior = None
                try:
                    if fixturedef.scope != 'function':
                        prior = _MON.current
                        node_path = getattr(request.node, 'path', None)
                        try:
                            file = Path(node_path).resolve().relative_to(_ROOT).as_posix() if node_path and Path(node_path).is_file() else 'global'
                        except ValueError:
                            file = 'global'
                        _MON.switch('fixture:' + file)
                except Exception as error:
                    _warn('fixture', error)
                try:
                    yield
                finally:
                    try:
                        if prior is not None:
                            _MON.switch(prior)
                    except Exception as error:
                        _warn('fixture', error)

        config.pluginmanager.register(BroadFixtureBoundary(), 'vibernt-cupel-broad-fixtures')

        class CollectionBoundary:
            @pytest.hookimpl(hookwrapper=True, tryfirst=True)
            def pytest_make_collect_report(self, collector):
                prior = None
                try:
                    path = getattr(collector, 'path', None)
                    if path is not None and Path(path).is_file() and Path(path).suffix == '.py':
                        file = Path(path).resolve().relative_to(_ROOT).as_posix()
                        prior = _MON.current
                        _MON.switch('collect:' + file)
                except Exception as error:
                    _warn('collection', error)
                try:
                    yield
                finally:
                    try:
                        if prior is not None:
                            _MON.switch(prior)
                    except Exception as error:
                        _warn('collection', error)

        config.pluginmanager.register(CollectionBoundary(), 'vibernt-cupel-collection-boundaries')
    except Exception as error:
        _warn('configure', error)


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
    try:
        path = _file(item)
        pieces = _name_parts(item.nodeid)
        name = ' > '.join(pieces)
        tags = sorted({m.name[6:] for m in item.iter_markers() if m.name in ('cupel_critical', 'cupel_standard', 'cupel_minor')})
    except Exception as error:
        _warn(getattr(item, 'nodeid', 'unknown item'), error)
        path = str(getattr(item, 'nodeid', 'unknown')).split('::')[0]
        name = str(getattr(item, 'nodeid', 'unknown')).split('::')[-1]
        tags = []
    test_id = f'{path}::{name}'
    row = {'id': test_id, 'file': path, 'name': name, 'nodeid': item.nodeid,
           'tags': tags, 'status': 'passed', 'duration': 0.0}
    try:
        function = item.function
        code = function.__code__
        definition = Path(code.co_filename).resolve().relative_to(_ROOT).as_posix()
        if definition not in _AST_CACHE:
            _AST_CACHE[definition] = ast.parse(Path(_ROOT, definition).read_text(encoding='utf-8'))
        functions = (n for n in ast.walk(_AST_CACHE[definition]) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)))
        fn = next((n for n in functions if n.lineno == code.co_firstlineno or
                   any(d.lineno == code.co_firstlineno for d in n.decorator_list)), None)
        if fn is None:
            raise ValueError(f'definition at {definition}:{code.co_firstlineno} not found')
        row['line'] = fn.lineno
        row['definitionFile'] = definition
        if definition != path:
            qualified = code.co_qualname.replace('.<locals>.', ' > ').replace('.', ' > ')
            row['unit'] = f'{path}::@{definition}::{qualified}'
    except Exception as error:
        _warn(item.nodeid, error)
    return row


def _warn(nodeid, error):
    detail = str(error).splitlines()
    print(f'cupel: warning: cannot analyse {nodeid}: {type(error).__name__}: {detail[0] if detail else "unknown error"}', file=sys.__stderr__)


def pytest_collection_finish(session):
    global _COLLECTED
    try:
        _COLLECTED = [_record(item) for item in session.items]
        if _MODE != 'list':
            _TESTS.update({row['id']: row for row in _COLLECTED})
        if _MODE == 'list':
            session.items[:] = []
    except Exception as error:
        _warn('collection', error)


def pytest_runtest_setup(item):
    try:
        if _MON:
            _MON.switch(next((r['id'] for r in _COLLECTED if r['nodeid'] == item.nodeid), _file(item) + '::' + ' > '.join(_name_parts(item.nodeid))))
    except Exception as error:
        _warn(item.nodeid, error)


def pytest_runtest_logreport(report):
    try:
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
    except Exception as error:
        _warn(report.nodeid, error)


def pytest_sessionfinish(session, exitstatus):
    try:
        if _MON:
            _MON.close()
        if _OUT:
            result = {'tests': _COLLECTED, 'spawns': sorted(_SPAWNED),
                      'buckets': {name: sorted(lines) for name, lines in (_MON.buckets if _MON else {}).items()}}
            Path(_OUT).write_text(json.dumps(result), encoding='utf-8')
    except Exception as error:
        _warn('session finish', error)
    finally:
        try:
            subprocess.Popen.__init__ = _ORIG_POPEN
            for name, original in _ORIG_EXEC.items():
                setattr(os, name, original)
        except Exception as error:
            _warn('restoration', error)
