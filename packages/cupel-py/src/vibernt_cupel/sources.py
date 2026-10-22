"""Whole-repository Python source selection (K2)."""
import fnmatch
import os
from functools import lru_cache
from pathlib import Path
from .lines import source_record

SKIP_DIRS = {'tests', 'test', '__tests__', '__test__', '.venv', 'venv', 'env', 'site-packages'}


def glob_match(path, glob):
    """Match Cupel scope globs, including zero or more segments for **."""
    parts, pattern = path.split('/'), glob.split('/')

    @lru_cache(None)
    def match(i, j):
        if j == len(pattern):
            return i == len(parts)
        if pattern[j] == '**':
            return match(i, j + 1) or (i < len(parts) and match(i + 1, j))
        return i < len(parts) and fnmatch.fnmatchcase(parts[i], pattern[j]) and match(i + 1, j + 1)

    return match(0, 0)


def scan(root, scope=None):
    scope = scope or {}
    include, exclude = scope.get('include', ['**']), scope.get('exclude', [])
    result = {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d not in SKIP_DIRS and not Path(directory, d).is_symlink())
        for name in sorted(files):
            if not name.endswith('.py') or name.startswith('.') or name == 'conftest.py' or name.startswith('test_') or name.endswith('_test.py'):
                continue
            path = Path(directory, name)
            if path.is_symlink():
                continue
            rel = path.relative_to(root).as_posix()
            if any(glob_match(rel, p) for p in include) and not any(glob_match(rel, p) for p in exclude):
                result[rel] = source_record(path)
    return result
