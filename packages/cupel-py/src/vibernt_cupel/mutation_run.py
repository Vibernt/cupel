"""Coverage-driven pytest mutation runner. All mutant source is stored outside project files."""
import json
import os
import random
import signal
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .mutation_scope import EnvironmentError, source_path, lines, own_lines, scope_lines, whole_units
from .mutation_sites import apply, generate


def _draw(items, amount, seed):
    if amount >= len(items):
        return list(items)
    indexes = list(range(len(items)))
    random.Random(seed).shuffle(indexes)
    return [items[i] for i in sorted(indexes[:amount])]


def _run(root, nodeids, env, tmp, timeout, deadline, spec=None):
    report = Path(tmp, f'report-{time.monotonic_ns()}.jsonl')
    child_env = {**os.environ, **env, 'PYTHONDONTWRITEBYTECODE': '1', 'CUPEL_MUTANT_REPORT': str(report)}
    if spec:
        child_env['CUPEL_MUTANT_SPEC'] = str(spec)
    else:
        child_env.pop('CUPEL_MUTANT_SPEC', None)
    src = str(Path(__file__).resolve().parents[1])
    child_env['PYTHONPATH'] = os.pathsep.join(filter(None, (src, child_env.get('PYTHONPATH', ''))))
    start = time.monotonic()
    budget = deadline - start
    if budget <= 0:
        return {'cut': True}
    command = [sys.executable, '-m', 'pytest', '-p', 'vibernt_cupel.mutant', '-p', 'no:cacheprovider', '-q', *nodeids]
    proc = subprocess.Popen(command, cwd=root, env=child_env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
    timed_out = cut = False
    try:
        _, stderr = proc.communicate(timeout=max(.001, min(timeout, budget)))
    except subprocess.TimeoutExpired:
        cut = budget <= timeout
        timed_out = not cut
        os.killpg(proc.pid, signal.SIGKILL)
        _, stderr = proc.communicate()
    elapsed = (time.monotonic() - start) * 1000
    try:
        reports = [json.loads(s) for s in report.read_text(encoding='utf-8').splitlines()] if report.exists() else []
    finally:
        report.unlink(missing_ok=True)
    return {'cut': cut, 'timeout': timed_out, 'code': proc.returncode, 'wall': elapsed, 'reports': reports, 'stderr': stderr.decode(errors='replace')[-1000:]}


class Session:
    def __init__(self, root, input_data, config, tmp, deadline, floor_ms=1000):
        self.root, self.input, self.config, self.tmp, self.deadline = root, input_data, config, tmp, deadline
        self.floor_ms = floor_ms
        self.tests = {t['id']: t for t in input_data['tests']}
        self.baselines = {}
        self.counter = 0
        self.env = config.get('runners', {}).get('pytest', {}).get('env', {})

    def select(self, site):
        cov = self.input['coverage']
        found = [t for t in self.input['tests'] if t['status'] == 'passed' and site.line in lines(cov.get('byTest', {}).get(t['id'], {}).get(site.source, ''))]
        files = {t['file'] for t in found}
        for mapping in ('setup', 'byFile'):
            for file, covered in cov.get(mapping, {}).items():
                if site.line in lines(covered.get(site.source, '')):
                    files.add(file)
        return [t for t in self.input['tests'] if t['status'] == 'passed' and t['file'] in files and (t in found or site.line in lines(cov.get('setup', {}).get(t['file'], {}).get(site.source, '')) or site.line in lines(cov.get('byFile', {}).get(t['file'], {}).get(site.source, '')))]

    def baseline(self, selected):
        key = tuple(t['id'] for t in selected)
        if key not in self.baselines:
            ids = [t['id'].replace(' > ', '::') for t in selected]
            for attempt in range(2):
                run = _run(self.root, ids, self.env, self.tmp, 600, self.deadline)
                if run['cut']:
                    return None
                ended = {r['nodeid'] for r in run['reports'] if r.get('when') == 'teardown'}
                if set(ids) <= ended and run['code'] in (0, 1) and not run['timeout']:
                    self.baselines[key] = run
                    break
            else:
                raise EnvironmentError(f'unmutated pytest selection did not complete: {ids}: {run["stderr"]}')
        return self.baselines[key]

    def once(self, site, selected):
        base = self.baseline(selected)
        if base is None:
            return None
        self.counter += 1
        tag = f'{self.counter}-{time.monotonic_ns()}'
        source_file = source_path(self.root, site.source)
        spec_path = Path(self.tmp, tag + '.json')
        seen_path = Path(self.tmp, tag + '.seen')
        spec_path.write_text(json.dumps({'source': str(source_file), 'edits': site.edits, 'seen': str(seen_path)}), encoding='utf-8')
        ids = [t['id'].replace(' > ', '::') for t in selected]
        passing = {t['id'].replace(' > ', '::'): t['id'] for t in selected}
        def classify(run):
            if run['cut']:
                return None
            baseline_failures = {r['nodeid'] for r in base['reports'] if r.get('failed')}
            killers = sorted({passing[r['nodeid']] for r in run['reports'] if r.get('failed') and r['nodeid'] in passing and r['nodeid'] not in baseline_failures})
            if killers:
                return 'killed', killers
            if run['timeout']:
                started = {r['nodeid'] for r in run['reports'] if r.get('event') == 'start'}
                ended = {r['nodeid'] for r in run['reports'] if r.get('when') == 'teardown'}
                hung = sorted(passing[nodeid] for nodeid in started - ended if nodeid in passing)
                return 'timeout', hung or sorted(t['id'] for t in selected)
            if run['code'] != base['code'] or not run['reports'] or len(run['reports']) < len(base['reports']):
                return 'crash', []
            return ('survived' if seen_path.exists() else 'error'), []
        try:
            limit = max(3 * base['wall'] / 1000, self.floor_ms / 1000)
            run = _run(self.root, ids, self.env, self.tmp, limit, self.deadline, spec_path)
            result = classify(run)
            if result and result[0] == 'timeout':
                fresh = _run(self.root, ids, self.env, self.tmp, 600, self.deadline)
                if fresh['cut']:
                    return None
                fresh_ended = {r['nodeid'] for r in fresh['reports'] if r.get('when') == 'teardown'}
                if not set(ids) <= fresh_ended or fresh['code'] != base['code']:
                    return ('error', [])
                run = _run(self.root, ids, self.env, self.tmp, 3 * max(limit, 3 * fresh['wall'] / 1000), self.deadline, spec_path)
                result = classify(run)
            if result and result[0] == 'crash':
                result = classify(_run(self.root, ids, self.env, self.tmp, limit, self.deadline, spec_path))
                if result and result[0] == 'crash':
                    result = ('error', [])
            return result
        finally:
            spec_path.unlink(missing_ok=True)
            seen_path.unlink(missing_ok=True)


def _entry(site, result):
    status, killers = result
    row = {'id': site.id, 'source': site.source, 'line': site.line, 'operator': site.operator, 'status': status}
    if killers:
        row['killedBy'] = killers
    return row


def mutate(root, input_data, scope, config=None, jobs=None, timeout_floor_ms=1000):
    config = config or {}
    options = config.get('mutation', {})
    cap, seconds, seed = options.get('maxMutants', 200), options.get('maxSeconds', 300), options.get('seed', 20261021)
    if cap < 1 or seconds < 1:
        raise ValueError('mutation maxMutants and maxSeconds must be positive')
    deadline = time.monotonic() + seconds
    wanted, own = scope_lines(input_data, scope, config)
    candidates, texts = [], {}
    for path, wanted_lines in wanted.items():
        if not path.endswith('.py'):
            raise EnvironmentError(f'cannot mutate non-Python source {path}')
        source = source_path(root, path)
        try:
            text = source.read_text(encoding='utf-8')
            compile(text, str(source), 'exec')
            texts[path] = text
            candidates.extend(s for s in generate(path, text) if s.line in wanted_lines)
        except (OSError, SyntaxError, UnicodeError) as error:
            raise EnvironmentError(f'cannot mutate {path}: {error}') from error
    targeted = [s for s in candidates if any(s.line in paths.get(s.source, set()) for paths in own.values())]
    other = [s for s in candidates if s not in targeted]
    if len(candidates) > cap:
        preferred = whole_units(targeted, own, cap) if len(targeted) >= cap else targeted + _draw(other, cap - len(targeted), seed)
        chosen = {s.id for s in preferred}
        ordered = preferred + _draw([s for s in targeted if s.id not in chosen], len(targeted), seed) + _draw([s for s in other if s.id not in chosen], len(other), seed)
    else:
        ordered = candidates
    jobs = max(1, jobs or (os.cpu_count() or 2) // 2)
    results, invalid = {}, set()
    scratch = Path(root, '.scratch')
    scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='cupel-pymut-', dir=scratch) as tmp:
        session = Session(root, input_data, config, tmp, deadline, timeout_floor_ms)
        cursor = 0
        while cursor < len(ordered) and len(results) < cap and time.monotonic() < deadline:
            batch = ordered[cursor:cursor + min(jobs, cap - len(results))]
            cursor += len(batch)
            valid = []
            for site in batch:
                text = apply(texts[site.source], site)
                try:
                    compile(text, site.source, 'exec')
                except (SyntaxError, ValueError):
                    invalid.add(site.id)
                else:
                    valid.append((site, text))
            def check(item):
                site, text = item
                selected = session.select(site)
                if not selected:
                    return ('no-coverage', [])
                return session.once(site, selected)
            with ThreadPoolExecutor(max_workers=jobs) as executor:
                done = list(executor.map(check, valid))
            for (site, _), result in zip(valid, done):
                if result is not None:
                    results[site.id] = result
    mutants = [_entry(site, results[site.id]) for site in candidates if site.id in results]
    complete = []
    for uid, paths in own.items():
        mine = [s for s in candidates if s.line in paths.get(s.source, set()) and s.id not in invalid]
        if all(s.id in results and results[s.id][0] != 'error' for s in mine):
            complete.append(uid)
    return {'mutants': mutants, 'targeted': sorted(complete), 'seed': seed, 'sampled': len(results) < len(candidates) - len(invalid)}


def confirm(root, input_data, mutation, ids, config=None, jobs=None, timeout_floor_ms=1000):
    index = {m['id']: m for m in mutation['mutants']}
    for mid in ids:
        if mid not in index:
            raise ValueError(f'confirm: unknown mutant {mid}')
    out = {**mutation, 'mutants': [dict(m) for m in mutation['mutants']]}
    changed = {m['id']: m for m in out['mutants']}
    scratch = Path(root, '.scratch')
    scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='cupel-pyconfirm-', dir=scratch) as tmp:
        session = Session(root, input_data, config or {}, tmp, float('inf'), timeout_floor_ms)
        cache = {}
        for mid in sorted(set(ids)):
            if index[mid]['status'] != 'survived':
                continue
            path = index[mid]['source']
            if path not in cache:
                text = source_path(root, path).read_text(encoding='utf-8')
                cache[path] = (text, {s.id: s for s in generate(path, text)})
            text, sites = cache[path]
            if mid not in sites:
                raise ValueError(f'confirm: {mid} cannot be regenerated; source changed')
            site = sites[mid]
            selected = session.select(site)
            for _ in range(2):
                result = session.once(site, selected) if selected else ('no-coverage', [])
                if result[0] != 'survived':
                    changed[mid] = _entry(site, result)
                    break
    if out.get('targeted'):
        own = own_lines(input_data, out['targeted'])
        errors = [m for m in changed.values() if m['status'] == 'error']
        out['targeted'] = [uid for uid in out['targeted'] if not any(m['line'] in own[uid].get(m['source'], set()) for m in errors)]
    return out
