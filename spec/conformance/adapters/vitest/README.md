# Vitest adapter fixture

A tiny TypeScript project with known per-test coverage. The Vitest collector, run here, must produce an input that matches [`expected.json`](expected.json) under the matching rules in [SPEC.md section 16](../../../SPEC.md#16-conformance-cases). It was verified on Vitest 4.1.11 and 5.0.1, under Node 22 and 26.

| What it proves | Where |
|---|---|
| Interface and type-only lines are not coverable (K1, through `stripTypeScriptTypes`) | `src/math.ts` lines 1–5 |
| Coverage is mapped back to original TypeScript lines through the source map | `byTest` line sets |
| A root `beforeEach` and `afterEach` count in each test (K3) | every test includes `cap`'s lines 11–13 and 15 |
| `afterAll` goes to `setup` (K3) | `setup` includes 11–15 (`cap(9)`) |
| `test.each` rows share the title format string as their unit (K10) | `cap > maps …`, unit `::cap > maps %i to %i` |
| A `[critical]` title tag becomes a tier tag | `add sums a pair [critical]` |

**A known mapping artifact.** Line 9, the closing brace of `add`, shows as covered in `setup`. Source maps map at segment granularity, so the brace takes the coverage of the top-level code that follows it in Vite's output. The only effect is that line 9 can never be unique to a test. SPEC K1 records this.
