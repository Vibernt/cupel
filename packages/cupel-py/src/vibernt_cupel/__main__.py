"""Command line entry point for the pytest adapter."""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from .lines import line_set
from .sources import scan
from .static import inspect


def _run(root, sources, args, mode='run'):
    scratch = root / '.scratch'
    scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='cupel-py-', dir=scratch) as tmp:
        result = Path(tmp, 'result.json')
        env = os.environ.copy()
        env.update(CUPEL_ROOT=str(root), CUPEL_RESULT=str(result), CUPEL_MODE=mode,
                   CUPEL_SOURCES=json.dumps(sorted(sources)), PYTHONDONTWRITEBYTECODE='1',
                   TMPDIR=tmp, XDG_CACHE_HOME=tmp)
        src = str(Path(__file__).resolve().parents[1])
        env['PYTHONPATH'] = os.pathsep.join(filter(None, (src, env.get('PYTHONPATH', ''))))
        command = [sys.executable, '-m', 'pytest', '-p', 'vibernt_cupel.plugin', '-p', 'no:cacheprovider', *args]
        proc = subprocess.run(command, cwd=root, env=env, text=True, capture_output=True)
        if not result.exists():
            raise RuntimeError(f'pytest collector failed (exit {proc.returncode}): {(proc.stderr or proc.stdout).strip()[-1000:]}')
        accepted = (0, 5) if mode == 'list' else (0, 1)
        if proc.returncode not in accepted:
            raise RuntimeError(f'pytest failed before completing tests (exit {proc.returncode}): {(proc.stderr or proc.stdout).strip()[-1000:]}')
        return json.loads(result.read_text(encoding='utf-8'))


def _lines(bucket, sources):
    by_source = {}
    for path, line in bucket:
        if path in sources:
            by_source.setdefault(path, set()).add(line)
    allowed = {p: set(_expand(rec['coverable'])) for p, rec in sources.items()}
    return {p: line_set(lines & allowed[p]) for p, lines in sorted(by_source.items()) if lines & allowed[p]}


def _expand(spec):
    for part in filter(None, spec.split(',')):
        ends = part.split('-')
        yield from range(int(ends[0]), int(ends[-1]) + 1)


def _rows(raw):
    rows = raw['tests']
    groups = {}
    for row in rows:
        if 'line' in row and 'unit' not in row:
            groups.setdefault((row['file'], row['line']), []).append(row)
    for group in groups.values():
        if len(group) > 1:
            for row in group:
                row['unit'] = f'{row["file"]}::@{row["line"]}'
    return rows


def collect(root, runs, recheck, pytest_args, mode='run'):
    if sys.version_info < (3, 12):
        raise RuntimeError('collection requires Python 3.12+ (sys.monitoring)')
    config_path = root / 'cupel.json'
    config = json.loads(config_path.read_text(encoding='utf-8')) if config_path.exists() else {}
    sources = scan(root, config.get('scope'))
    first = _run(root, sources, pytest_args, mode)
    rows = _rows(first)
    ids = {r['id'] for r in rows}
    statuses = {row['id']: [row['status']] for row in rows}
    spawned = set(first['spawns'])
    for repeat in range(1, runs):
        again = _run(root, sources, pytest_args)
        if {r['id'] for r in again['tests']} != ids:
            raise RuntimeError('test ids changed between runs')
        by_id = {r['id']: r for r in again['tests']}
        spawned.update(again['spawns'])
        for row in rows:
            row.setdefault('durationsMs', [max(0, round(row['duration'] * 1000))]).append(max(0, round(by_id[row['id']]['duration'] * 1000)))
            statuses[row['id']].append(by_id[row['id']]['status'])
    by_test = {r['id']: _lines(first['buckets'].get(r['id'], []), sources) for r in rows}
    checked = []
    for unit in dict.fromkeys(recheck):
        selected = [r for r in rows if r.get('unit', r['id']) == unit]
        if not selected:
            raise ValueError(f'unknown recheck unit: {unit}')
        isolated = _run(root, sources, [*(r['nodeid'] for r in selected), *pytest_args])
        found = {r['id'] for r in isolated['tests']}
        if found != {r['id'] for r in selected}:
            raise RuntimeError(f'recheck did not select exactly {unit}')
        for row in selected:
            by_test[row['id']] = _lines(isolated['buckets'].get(row['id'], []), sources)
        checked.append(unit)
    setup_lines = first['buckets'].get('setup', []) + first['buckets'].get('between', [])
    setup = {file: _lines(setup_lines + first['buckets'].get('collect:' + file, []) + first['buckets'].get('fixture:global', []) + first['buckets'].get('fixture:' + file, []), sources) for file in sorted({r['file'] for r in rows})}
    shapes, brittle = inspect(root, rows, config.get('brittleness', {}).get('patterns', []))
    tests = []
    for r in sorted(rows, key=lambda x: x['id']):
        test = {k: r[k] for k in ('id', 'file', 'name')}
        if 'unit' in r:
            test['unit'] = r['unit']
        outcomes = statuses[r['id']]
        status = 'failed' if 'failed' in outcomes else 'skipped' if all(x == 'skipped' for x in outcomes) else 'passed'
        test.update(tags=r['tags'], status=status,
                    durationsMs=r.get('durationsMs', [max(0, round(r['duration'] * 1000))]),
                    spawnsInterpreter=r['id'] in spawned)
        tests.append(test)
    return {'spec': 'cupel-spec/1', 'kind': 'input', 'runtime': {'name': 'python', 'version': sys.version.split()[0]},
            'sources': sources, 'tests': tests,
            'coverage': {'granularity': 'test', 'byTest': by_test, 'setup': setup, 'rechecked': sorted(checked)},
            'shapes': shapes, 'brittleness': brittle}


def main(argv=None):
    parser = argparse.ArgumentParser(prog='python -m vibernt_cupel')
    parser.add_argument('command', choices=('collect', 'list', 'select', 'mutate', 'confirm', 'body-sites'))
    parser.add_argument('ids', nargs='*')
    parser.add_argument('--root', default='.')
    parser.add_argument('--runs', type=int, default=2)
    parser.add_argument('--recheck', action='append', nargs='+', default=[])
    parser.add_argument('--out')
    parser.add_argument('--input')
    parser.add_argument('--scope')
    parser.add_argument('--config')
    parser.add_argument('--mutation')
    parser.add_argument('--jobs', type=int)
    parser.add_argument('--ids', nargs='+', dest='confirm_ids')
    argv = list(sys.argv[1:] if argv is None else argv)
    divider = argv.index('--') if '--' in argv else len(argv)
    args, unknown = parser.parse_known_args(argv[:divider])
    extra = unknown + argv[divider + 1:] if divider < len(argv) else unknown
    if args.runs < 1:
        parser.error('--runs must be positive')
    if args.command == 'collect' and args.ids:
        parser.error('collect accepts pytest arguments after --')
    if args.command == 'select' and not args.ids:
        parser.error('select requires test ids')
    if args.command == 'select' and extra:
        parser.error('select accepts only test ids and adapter options')
    if args.command == 'mutate' and (not args.input or not args.scope or args.ids or extra):
        parser.error('mutate needs --input and --scope, and accepts no pytest arguments')
    if args.command == 'confirm' and (not args.input or not args.mutation or not (args.ids or args.confirm_ids) or extra):
        parser.error('confirm needs --input, --mutation and mutant ids')
    if args.jobs is not None and args.jobs < 1:
        parser.error('--jobs must be positive')
    root = Path(args.root).resolve()
    if extra and extra[0] == '--':
        extra = extra[1:]
    try:
        if args.command == 'body-sites':
            from .mutation_sites import generate
            if not args.input:
                parser.error('body-sites needs --input')
            data = json.loads(Path(args.input).read_text(encoding='utf-8'))
            value = []
            for path in sorted(data['sources']):
                if not path.endswith('.py'):
                    continue
                source = (root / path).resolve()
                if not source.is_relative_to(root):
                    raise ValueError(f'source escapes root: {path}')
                for site in generate(path, source.read_text(encoding='utf-8'), functions_only=True):
                    value.append({'id': site.id, 'source': site.source, 'operator': site.operator,
                                  'function_key': site.function_key, 'function_name': site.function_name,
                                  'start_line': site.start_line, 'end_line': site.end_line, 'variant': site.variant})
        elif args.command in ('mutate', 'confirm'):
            from .mutation_run import mutate, confirm
            data = json.loads(Path(args.input).read_text(encoding='utf-8'))
            config_file = Path(args.config) if args.config else root / 'cupel.json'
            if args.config and not config_file.exists():
                raise FileNotFoundError(f'config not found: {config_file}')
            config = json.loads(config_file.read_text(encoding='utf-8')) if config_file.exists() else {}
            if args.command == 'mutate':
                scope = json.loads(Path(args.scope).read_text(encoding='utf-8'))
                mutation = mutate(root, data, scope, config, args.jobs)
                value = {**data, 'mutation': mutation}
            else:
                previous = json.loads(Path(args.mutation).read_text(encoding='utf-8'))
                mutation = previous.get('mutation', previous)
                value = confirm(root, data, mutation, args.confirm_ids or args.ids, config, args.jobs)
        elif args.command == 'list':
            raw = _run(root, scan(root), extra, 'list')
            rows = _rows(raw)
            value = {'tests': [{k: r[k] for k in ('id', 'file', 'name', 'tags', 'unit') if k in r} for r in sorted(rows, key=lambda x: x['id'])]}
        else:
            recheck = [unit for group in args.recheck for unit in group]
            if args.command == 'select':
                listed = _rows(_run(root, scan(root), extra, 'list'))
                by_id = {row['id']: row['nodeid'] for row in listed}
                missing = [test_id for test_id in args.ids if test_id not in by_id]
                if missing:
                    raise ValueError(f'unknown test id: {missing[0]}')
                targets = [by_id[test_id] for test_id in args.ids]
            else:
                targets = []
            value = collect(root, args.runs, recheck, [*targets, *extra])
        text = json.dumps(value, indent=2) + '\n'
        if args.out:
            Path(args.out).write_text(text, encoding='utf-8')
        else:
            sys.stdout.write(text)
        return 0
    except (RuntimeError, ValueError, OSError) as error:
        print(f'vibernt-cupel: {error}', file=sys.stderr)
        return 3


if __name__ == '__main__':
    sys.exit(main())
