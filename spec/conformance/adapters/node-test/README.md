# node:test adapter fixture

A tiny project with known per-test coverage. A node:test adapter run in this directory must produce an input that matches [`expected.json`](expected.json), using the matching rules in [SPEC.md section 16](../../../SPEC.md#16-conformance-cases).

| What it proves | Where |
|---|---|
| Module loading goes to `setup`, including `export function` header lines (K1, K3) | `setup`: lines 2, 4, 8, 14 |
| A root `beforeEach` runs inside each test without adding source lines (K3) | `tests/math.test.mjs` lines 6–8 |
| Each test covers exactly its own path (K1) | `byTest` |
| Rows of a loop share the raw source title as their unit (K10) | `clamp keeps …` rows, unit `::clamp keeps ${x} in range` |
| A nested test's id joins suite levels with ` > ` (K10) | `clamp > low bound` |
| A `[critical]` title tag becomes a tier tag (adapter contract, Tags) | `add sums two numbers [critical]` |
| Comment and blank lines are not coverable; uncalled code stays uncovered (K1) | `coverable`, lines 15–16 |
| The scope leaves out test files (K2) | only `src/math.mjs` in `sources` |

Run it with `cupel conformance --adapter <command>` once the CLI exists (M3).
