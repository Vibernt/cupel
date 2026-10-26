# S12b Python dependency pilot

This is an offline capability experiment, not a production collector or a safe
pytest selector. Its only writes are under this pilot folder and ignored
`.scratch/s12b/py-pilot/`. It reads no candidate repository and no file
contents into the sidecar.

## Run

`python3 -m unittest discover -s plans/spikes/s12b/py-pilot -p 'test_*.py' -v`

The test uses the required isolated interpreter
`.scratch/package-tools/runtime/bin/python` (pytest 9.1.1). It exits if that
interpreter is absent. `replay.py` runs a fresh ordinary full baseline with
`trace_plugin`, applies a fixture mutation, then runs the ordinary full oracle
and the named selected files. Raw logs, sidecars and `results.jsonl` are in
`.scratch/s12b/py-pilot/`.

To capture a separate scratch pytest project, set `PYTHONPATH` to this folder
and the project root, plus these required environment variables:
`CUPEL_PY_PILOT_ROOT` (absolute project root), `CUPEL_PY_PILOT_OUT` (sidecar
path), `CUPEL_PY_PILOT_EXPECTED_FILES` (JSON array of exact test files),
`CUPEL_PY_PILOT_CONFIG_HASH` and `CUPEL_PY_PILOT_ENV_HASH` (SHA-256 identities
from the caller's actual launch policy). Run that exact interpreter from the
project root with `-m pytest -q -p no:cacheprovider -p trace_plugin tests`.
The output uses `version: cupel-pr-dependencies/1`, exact runner/runtime,
execution hashes, file/global dependency channels, actual call IDs,
unsupported reasons and expected/finished/error completion fields. The pilot
sets `execution.isolation: shared-process` and global
`shared-process-state-unproven` on every capture.

## Results, 2026-10-25

Four pilot tests passed in 6.4 s. Sixteen actual passing pytest baselines ran.
Eight changed-source faults had actual full oracles; seven were caught by the
observed path-file selection. The exact S12 source-text pin plus executable
coverage selected both affected files. Cached constant import across two test
files, cached import-time data read, `Path.read_text`/`io.open`/`os.open`, an
absent `exists()` probe, a new directory entry and a global conftest import
were also captured and replayed. Reads by source modules during import are
conservatively global dependencies.

One path-only selection was **false green**: `test_a.py` imports and primes a
module global; `test_b.py` reads it through `sys.modules`, without importing or
reading the source. Changing the source made the ordinary full oracle fail,
while running selected `test_a.py` alone passed. A named per-file process run
also fails baseline parity: the ordinary full baseline passes both files, but
isolated `test_b.py` fails. Thus neither shared-process path selection nor a
silent per-file isolation switch is supported by this pilot.

Eight other baselines explicitly carried unsupported reasons: project file
write, child process, thread, native load, external read, symlink boundary,
untracked descriptor and failed import. Their tests passed, but evidence was
refused. All sixteen sidecars had matching expected/finished files and no
completion error. They also all carry `shared-process-state-unproven`, so none
is selectable as production evidence. The seven caught faults are tracing
capability checks, not shipping safety acceptance.

## Boundary and next action

Python audit hooks and wrappers are incomplete for arbitrary native code,
descriptor and memory state, and other interpreter behavior. The bounded next
action is a separately specified execution lane with explicit full-oracle
parity on baseline and head, or an explicit pytest refusal in selective PR
mode. Do not infer a universal absence of shared state from file observations.
