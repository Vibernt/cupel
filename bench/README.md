# Benchmark harness

Run from the Cupel worktree root with Colima's linux/arm64 Docker daemon. The harness has no host-side dependency beyond Node 22 and Docker. It does not run candidate commands on the host. It runs each candidate in an official image with only three mounts: that candidate's directory at `/work`, this Cupel tree read-only at `/cupel`, and a named per-candidate cache volume at `/cache`. It forwards no host credentials or home directory.

```sh
node bench/run.mjs browser-tools-mcp all
node bench/report.mjs
```

`all` runs `install`, three plain `baseline` runs, `report`, five `guard-replay` comparisons and ten `plan-replay` comparisons, stopping on the first failed stage. Individual stages can be run as `node bench/run.mjs <name> <stage>` after their prerequisites. Each stage writes `bench/results/<name>/<stage>.json`; a failed stage records its reason. `guard` verdict failure on an historical commit is benchmark data, not a harness failure. Go, Rust, .NET and Ruby have no collectors yet: their report and replay stages record `pending: collector` after the baseline. Vitest report stages require the forthcoming Cupel Vitest collector; a missing or incorrect collector is a failure, with no substitution.

Only installation and archive installation use Docker `--network bridge`. The main install stage fetches the full reachable object set for the candidate's current HEAD and checks that no objects remain missing; this is necessary because the supplied clones omit file blobs. Baseline, collection, guard and plan use `--network none`. Host-side Git reads and container archive extraction disable lazy fetching; a missing object fails its stage. Source-changing commits use zero-context `git diff` line sets. Report collection uses `--runs 2` and a separate no-mutation pass to measure collection overhead. The full report includes mutation within the configured cap.

Python candidates use `python:3.13-bookworm`. During install, Debian npm bootstraps Node 22.19.0 into `/cache/node`; the report stage puts that binary on `PATH` and puts `/cupel/packages/cupel-py/src` on `PYTHONPATH`. The two pytest suites use the same exclusions in the plain baseline and the Cupel collector through `PYTEST_ADDOPTS`. Go's install stage similarly builds the required UI with cached Node 22.19.0 and lets Go acquire the version declared in `go.mod`.

Python replay installs each archived revision into the shared cached virtual environment immediately before collecting it. After a successful replay, the harness reinstalls the root revision. If replay fails partway through, run the `install` stage again before another root collection; the virtual environment may still point to the failed archive.

## Cleanup after review

- Candidate repositories: remove `.cupel-bench.json`, `.cupel/`, `.cupel-bench-replay-*` and `.cupel-bench-changed-lines.json`. Do this only after preserving the results you need. Replay directories and the changed-lines file are automatically removed on normal completion or failure.
- Harness: remove `bench/results/<name>/` for a candidate, or all result directories when finished. Keep `bench/results/.gitkeep`. `bench/BENCHMARK.md` is generated and meant to be reviewed and committed only when real results exist.
- Docker: remove named `cupel-bench-<name>-cache` volumes when no longer needed. The harness does not remove volumes automatically.

The sandbox used to build this harness cannot run Docker or access the network. The generated `BENCHMARK.md` currently says `not run` throughout; no timings or quality findings have been fabricated.
