"""Mutation scope, own-line accounting, and whole-unit selection."""
from pathlib import Path

from .match import critical_source, glob_matches


class EnvironmentError(RuntimeError):
    pass


def source_path(root, path):
    relative = Path(path)
    if relative.is_absolute() or any(part in ('..', '.') or part.startswith('.') for part in relative.parts):
        raise EnvironmentError(f'source path is outside Python scope: {path}')
    base = Path(root).resolve()
    resolved = (base / relative).resolve()
    if not resolved.is_relative_to(base):
        raise EnvironmentError(f'source path escapes root: {path}')
    return resolved


def lines(value):
    if isinstance(value, list):
        return set(value)
    result = set()
    for part in filter(None, str(value or '').split(',')):
        ends = part.split('-')
        result.update(range(int(ends[0]), int(ends[-1]) + 1))
    return result


def union(maps):
    result = {}
    for record in maps:
        for path, value in record.items():
            result.setdefault(path, set()).update(lines(value))
    return result


def own_lines(input_data, ids):
    tests = input_data['tests']
    coverage = input_data['coverage']
    result = {}
    for uid in ids:
        rows = [t for t in tests if t.get('unit', t['id']) == uid]
        if not rows:
            raise ValueError(f'scope.targeted: unknown unit {uid}')
        file = rows[0]['file']
        maps = [coverage.get('byTest', {}).get(t['id'], {}) for t in rows]
        if coverage.get('granularity') == 'file':
            maps.append(coverage.get('byFile', {}).get(file, {}))
        merged = union(maps)
        setup = coverage.get('setup', {}).get(file, {})
        result[uid] = {path: value - lines(setup.get(path, '')) for path, value in merged.items()}
    return result


def scope_lines(input_data, scope, config):
    own = own_lines(input_data, scope.get('targeted', []))
    selected = {}
    def add(path, wanted):
        if path in input_data['sources']:
            covered = lines(input_data['sources'][path]['coverable'])
            selected.setdefault(path, set()).update(wanted & covered)
    if scope.get('critical'):
        for path, record in input_data['sources'].items():
            if critical_source(path, config):
                add(path, lines(record['coverable']))
    for path, value in (scope.get('changed') or {}).items():
        if path in input_data['sources']:
            add(path, lines(input_data['sources'][path]['coverable']) if value == '' or value == [] else lines(value))
    for paths in own.values():
        for path, value in paths.items():
            add(path, value)
    rule = config.get('scope', {})
    include, exclude = rule.get('include', ['**']), rule.get('exclude', [])
    return {p: value for p, value in sorted(selected.items()) if value and any(glob_matches(g, p) for g in include) and not any(glob_matches(g, p) for g in exclude)}, own


def whole_units(sites, own, cap):
    groups = []
    for uid, paths in own.items():
        mine = [s for s in sites if s.line in paths.get(s.source, set())]
        if mine:
            groups.append((len(mine), uid, mine))
    chosen = set()
    for _, _, group in sorted(groups):
        extra = {s.id for s in group} - chosen
        if len(chosen) + len(extra) <= cap:
            chosen.update(extra)
    return [s for s in sites if s.id in chosen]


