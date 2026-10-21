#!/bin/sh
# S6: run CodeCrystal's pytest suite from the snapshot copy, plain or with the per-test coverage plugin.
#
# Usage: plans/spikes/s6/run-pytest.sh <plain|coverage|off> <out.json-or-dir> [pytest args...]
#   plain     the instructed command, nothing added
#   coverage  the same plus -p cupel_s6_pytest (CUPEL_S6_MODE=coverage)
#   off       the plugin loaded with monitoring off (hooks and bookkeeping only)
# The copy's code is imported (PYTHONPATH=$PWD/src); nothing is written into the original repo
# (PYTHONDONTWRITEBYTECODE=1, -p no:cacheprovider). Timing comes from /usr/bin/time -p on stderr.
set -u
S6=$(cd "$(dirname "$0")" && pwd)
CC=${CUPEL_S6_CC:-/Users/vid/cupel/.scratch/cc-s6}
PY=/Users/vid/codecrystal/.venv/bin/python
mode=$1; out=$2; shift 2
cd "$CC" || exit 3
export PYTHONDONTWRITEBYTECODE=1
case "$mode" in
  plain) PYTHONPATH="$CC/src" /usr/bin/time -p "$PY" -m pytest -q -p no:cacheprovider -m "not load" --ignore-glob='tests/test_ai_cv_*' "$@" ;;
  coverage|off)
    CUPEL_S6_MODE=$( [ "$mode" = off ] && echo off || echo coverage ) CUPEL_S6_OUT="$out" CUPEL_S6_ROOT="$CC" \
    CUPEL_S6_WATCH=/Users/vid/codecrystal/src/ PYTHONPATH="$CC/src:$S6" \
      /usr/bin/time -p "$PY" -m pytest -q -p no:cacheprovider -p cupel_s6_pytest -m "not load" --ignore-glob='tests/test_ai_cv_*' "$@" ;;
  *) echo "usage: run-pytest.sh plain|coverage|off <out> [pytest args]" >&2; exit 2 ;;
esac
