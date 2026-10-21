#!/bin/sh
# S6: the pytest collector's overhead on in-process-heavy CodeCrystal test files, modes interleaved
# (plain, off, coverage) to spread machine load evenly. Prints one line per run: mode rep wall user sys.
#
# Usage: plans/spikes/s6/bench-pytest.sh <out-dir> <reps> <test files...>
set -u
S6=$(cd "$(dirname "$0")" && pwd)
out=$1; reps=$2; shift 2
mkdir -p "$out"
rep=1
while [ "$rep" -le "$reps" ]; do
  for mode in plain off coverage; do
    "$S6/run-pytest.sh" "$mode" "$out/bench-$mode-$rep.json" "$@" > "$out/bench-$mode-$rep.log" 2>&1
    wall=$(awk '/^real/ {print $2}' "$out/bench-$mode-$rep.log")
    user=$(awk '/^user/ {print $2}' "$out/bench-$mode-$rep.log")
    sys=$(awk '/^sys/ {print $2}' "$out/bench-$mode-$rep.log")
    res=$(grep -E "passed|failed" "$out/bench-$mode-$rep.log" | tail -1)
    echo "$mode $rep $wall $user $sys $(uptime | sed 's/.*averages: //') | $res"
  done
  rep=$((rep + 1))
done
