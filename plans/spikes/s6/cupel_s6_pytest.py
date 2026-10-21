"""S6: per-test line coverage for pytest with sys.monitoring (Python 3.12+). Standard library only.

The seed of Cupel's pytest collector (packages/cupel-py).

Usage (from the suite root):
    CUPEL_S6_OUT=/abs/out.json CUPEL_S6_ROOT=$PWD \
    PYTHONPATH=$PWD/src:/abs/plans/spikes/s6 python -m pytest -p cupel_s6_pytest ...

Environment:
    CUPEL_S6_OUT    where to write the JSON result (required to write anything)
    CUPEL_S6_ROOT   the suite root (default: the current directory)
    CUPEL_S6_SCOPE  'repo' (default): every file under the root except tests/, dot-directories, virtualenvs and
                    site-packages; or 'src': only <root>/src/
    CUPEL_S6_WATCH  optional path prefix (for example a sibling checkout the editable install points at); code
                    from there is not counted, but the files each test loads from it are recorded
    CUPEL_S6_MODE   'coverage' (default) or 'off' (hooks and timing only, to measure the plugin's own cost)

How it works:
  - One tool id (COVERAGE_ID if free). The only global event is PY_START. On the first PY_START of a code object
    in scope, LINE events are switched on for that code object alone (set_local_events); out-of-scope code
    returns DISABLE and costs nothing further until the next restart.
  - The LINE callback records (file, line) in the current bucket and returns DISABLE, so each line is recorded at
    most once per bucket. At each bucket switch, sys.monitoring.restart_events() re-arms every disabled
    location, so the next bucket sees its own first execution of each line.
  - Buckets: 'setup' until the first test starts (plugin load, conftest and module import during collection);
    then one bucket per test, from pytest_runtest_setup to the end of its teardown (fixtures, call and teardown
    are the test's); 'between' after a test; 'teardown' after the session's last test.
  - Known biases: code that runs only once per process (lazy imports inside a test, module- or session-scoped
    fixtures, caches) is credited to the first test that reaches it ("first touch", as in S2). Threads share
    the current bucket. Subprocesses are invisible; each test's subprocess launches are counted.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time

import pytest

_MON = sys.monitoring
_EV = _MON.events
_DISABLE = _MON.DISABLE

_ROOT = os.path.realpath(os.environ.get('CUPEL_S6_ROOT') or os.getcwd())
_SCOPE = os.environ.get('CUPEL_S6_SCOPE', 'repo')
_WATCH = os.environ.get('CUPEL_S6_WATCH') or None
_MODE = os.environ.get('CUPEL_S6_MODE', 'coverage')
_OUT = os.environ.get('CUPEL_S6_OUT')

_EXCLUDE_PARTS = ('/tests/', '/.', '/node_modules/', '/site-packages/', '/.venv/', '/venv/')
_scope_cache: dict[str, str | None] = {}  # filename -> relative path, '' for watched, None for out of scope


def _classify(filename: str):
    r = _scope_cache.get(filename, 0)
    if r != 0:
        return r
    out = None
    path = filename
    if path.startswith(_ROOT + os.sep):
        rel = path[len(_ROOT) + 1:]
        if _SCOPE == 'src':
            out = rel if rel.startswith('src/') else None
        else:
            probe = '/' + rel
            out = None if any(p in probe for p in _EXCLUDE_PARTS) or rel.startswith('tests/') else rel
    elif _WATCH and path.startswith(_WATCH):
        out = ''
    _scope_cache[filename] = out
    return out


class _State:
    def __init__(self):
        self.bucket_name = 'setup'
        self.bucket: set = set()
        self.watched: set = set()
        self.buckets: dict[str, set] = {'setup': self.bucket}
        self.watched_by: dict[str, set] = {'setup': self.watched}
        self.spawned: dict[str, list] = {}
        self.tests: dict[str, dict] = {}
        self.order: list[str] = []
        # Keyed by id(): code objects compare equal by value, so two loads of one file (a module imported under
        # a second name) would otherwise share an entry and the second copy would never be armed. The dict keeps
        # each code object alive, so its id is not reused.
        self.armed: dict = {}
        self.t0 = time.perf_counter()
        self.restarts = 0
        self.restart_s = 0.0


S = _State()
_TOOL = None


def _py_start(code, offset):
    rel = _classify(code.co_filename)
    if rel is None:
        return _DISABLE
    if rel == '':
        S.watched.add(code.co_filename)
        return _DISABLE
    if id(code) not in S.armed:
        S.armed[id(code)] = code
        _MON.set_local_events(_TOOL, code, _EV.LINE)
    return _DISABLE


def _line(code, line):
    S.bucket.add((code.co_filename, line))
    return _DISABLE


def _switch(name: str):
    S.bucket_name = name
    S.bucket = S.buckets.setdefault(name, set())
    S.watched = S.watched_by.setdefault(name, set())
    if _TOOL is not None:
        t = time.perf_counter()
        _MON.restart_events()
        S.restart_s += time.perf_counter() - t
        S.restarts += 1


def _start():
    global _TOOL
    if _MODE != 'coverage':
        return
    for tid in (_MON.COVERAGE_ID, 3, 4):
        if _MON.get_tool(tid) is None:
            _MON.use_tool_id(tid, 'cupel-s6')
            _TOOL = tid
            break
    if _TOOL is None:
        raise RuntimeError('cupel-s6: no free sys.monitoring tool id')
    _MON.register_callback(_TOOL, _EV.PY_START, _py_start)
    _MON.register_callback(_TOOL, _EV.LINE, _line)
    _MON.set_events(_TOOL, _EV.PY_START)


_start()

# Count subprocess launches per bucket (their coverage is invisible).
_orig_popen_init = subprocess.Popen.__init__


def _counted_init(self, args, *a, **kw):
    try:
        first = args if isinstance(args, (str, bytes)) else (list(args)[0] if args else '')
        what = os.path.basename(str(first).split(' ')[0])
    except Exception:  # never break the suite
        what = '?'
    S.spawned.setdefault(S.bucket_name, []).append(what)
    return _orig_popen_init(self, args, *a, **kw)


subprocess.Popen.__init__ = _counted_init


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_setup(item):
    _switch(item.nodeid)
    S.order.append(item.nodeid)
    S.tests[item.nodeid] = {'id': item.nodeid, 'file': str(item.path.relative_to(_ROOT)) if str(item.path).startswith(_ROOT) else str(item.path),
                            'name': item.name, 'durations': {}, 'outcome': None, 'markers': sorted({m.name for m in item.iter_markers()})}


@pytest.hookimpl(trylast=True)
def pytest_runtest_teardown(item, nextitem):
    pass  # the teardown phase still belongs to the test; the switch happens in logreport('teardown')


def pytest_runtest_logreport(report):
    t = S.tests.get(report.nodeid)
    if t is None:
        return
    t['durations'][report.when] = round(report.duration, 6)
    if report.when == 'call' or (report.when == 'setup' and report.outcome != 'passed'):
        t['outcome'] = 'skipped' if report.skipped else report.outcome
    if report.when == 'teardown':
        if report.outcome == 'failed':
            t['outcome'] = 'error'
        _switch('between')


def pytest_sessionfinish(session, exitstatus):
    _switch('teardown')
    if _TOOL is not None:
        _MON.set_events(_TOOL, 0)
        _MON.free_tool_id(_TOOL)
    if not _OUT:
        return
    t = time.perf_counter()

    def rel_lines(bucket):
        out: dict[str, list] = {}
        for f, line in bucket:
            r = _classify(f)
            if r:
                out.setdefault(r, []).append(line)
        return {k: sorted(v) for k, v in sorted(out.items())}

    tests = []
    for nodeid in S.order:
        rec = dict(S.tests[nodeid])
        rec['lines'] = rel_lines(S.buckets.get(nodeid, ()))
        rec['spawned'] = S.spawned.get(nodeid, [])
        rec['watched'] = sorted(os.path.relpath(p, _WATCH) for p in S.watched_by.get(nodeid, ()))
        tests.append(rec)
    body = {
        'root': _ROOT, 'scope': _SCOPE, 'python': sys.version.split()[0], 'mode': _MODE,
        'restarts': S.restarts, 'restartSeconds': round(S.restart_s, 4),
        'sessionSeconds': round(time.perf_counter() - S.t0, 3),
        'setup': rel_lines(S.buckets.get('setup', ())),
        'between': rel_lines(S.buckets.get('between', ())),
        'teardown': rel_lines(S.buckets.get('teardown', ())),
        'setupWatched': sorted(os.path.relpath(p, _WATCH) for p in S.watched_by.get('setup', ())) if _WATCH else [],
        'tests': tests,
    }
    body['writeSeconds'] = round(time.perf_counter() - t, 3)
    with open(_OUT, 'w') as fh:
        json.dump(body, fh)
