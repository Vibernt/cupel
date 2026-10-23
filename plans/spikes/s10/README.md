# S10: cleanup signals that look at what tests assert

Two spike parts, built after S6, S8 and S6b showed that coverage and code mutation can't see assertions. Neither changes D5 (no retire advice) or D14.

## S10a: extreme mutation for pseudo-tested functions

### Boundary

This is an analysis spike outside `spec/` and `packages/cupel/src/engine/`. It reports evidence for review. It never changes D5's ban on retire advice or D14's `no-unique-evidence` verdict.

## Commands

From a project root, run `cupel pseudo --json` for machine-readable output or `cupel pseudo` for the function and unit lists. `cupel pseudo --input .scratch/input.json --json` reads a Cupel input; if it has no mutation data, the command runs function-scope mutation, and if it has body-replace mutation data, the command confirms its survivors. The source files must still be present at the project root. Use the project's configured Node, Vitest or pytest runner. All temporary mutant and collector files are under that project's `.scratch/` and are removed after the run.

The direct APIs are `mutateNode({ root, input, scope: { functions: true } })`, `mutateVitest(...)`, and Python `mutate(root, input_data, {'functions': True})`. The CLI collects first, then runs the direct mutator and confirms survivors. The direct APIs return mutation data and do not themselves confirm survivors.

## Exact definitions

- A **function** is an eligible body-replace site group. JS/TS includes declarations, expressions, block arrows, methods, getters and setters with at least two top-level statements. It skips constructors and generators. Python includes `def` and `async def`; it skips `__init__` and methods decorated with `abstractmethod`.
- A **covered function** has at least one of its body lines in a passed test's recorded coverage. A function without a first-variant result because of a cap, invalid mutant or interruption remains `incomplete`.
- The **first variant** replaces the body with `return;` in JS/TS and `pass` in Python. A **second variant** is run only when the first survives. JS/TS adds one return default when a static return annotation or return expression indicates a boolean (`false`), number (`0`), string (`''`), array (`[]`), object (`{}`) or null (`null`). Unknown and void returns get only the first variant. Python uses `return None` as its second variant. A constructor, generator, abstract method or small JS/TS function has no body-replace site. Site IDs depend only on source path, position, variant and replacement.
- A **pseudo-tested function** is covered and every applicable body-replace variant survived, including the second variant when the first survives. An error, missing result or no coverage cannot qualify. A **tested function** has at least one killed or timed-out variant under the existing kill rule. Other covered functions are `incomplete`.
- A unit's **own lines** are the union of its test rows' recorded coverage, minus the test file's setup coverage. File-granularity coverage uses the file's coverage. A **pseudo-test** has at least one own line and every own line lies inside a pseudo-tested function's body span. A line outside all eligible function spans prevents this label. A unit with no own lines is not a pseudo-test.
- A unit's **pseudo share** is its number of covered eligible pseudo-tested functions divided by its number of covered eligible functions. `incomplete` functions stay in the denominator. The share is zero when the denominator is zero. It is an evidence fraction, not a redundancy or retirement verdict.

Function scope uses the existing covered-line selection, seeded cap, whole-unit selection when targeted units are supplied, baseline, in-memory source transport, timeout and kill rules. The CLI confirms all survivors. The first variant is scheduled across functions before any second variant, including when parallel jobs exceed one.

## Synthetic measurements

The synthetic projects each contain one call-only function and one function whose return is asserted. Each project has one test per function. The source and test files were hashed before and after mutation; no source or test file changed. Temporary files stayed in `.scratch/`.

| Runtime | Call-only function | Asserted function | Total mutants | Classification |
| --- | ---: | ---: | ---: | --- |
| Node `node:test` | 2 survived | 1 killed | 3 | 1 pseudo-tested function, 1 pseudo-test; 1 tested function |
| Vitest 4.1.11, read-only package from CodeCrystal | 2 survived | 1 killed | 3 | same |
| pytest 9.1.1, read-only CodeCrystal Python | 2 survived | 1 killed | 3 | same |

Each synthetic mutation was run twice with identical result JSON. The tested function's second variant was not run after the first was killed. The call-only unit's pseudo share was 1; the asserted unit's share was 0. The Python test used the real pytest collector and passed its result through the same pure analysis module. Node and Vitest used their real collectors. Node exercised `cupel pseudo` with a saved input and with live collection; Python exercised the live CLI path, including collection, mutation, confirmation and the Python site catalogue. Targeted-unit completion and a one-mutant cap were tested for Node and Python.

## Verdict and limits

The spike establishes the defined signal on the three synthetic examples. It does not establish precision on real repositories, or that a pseudo-test has no useful assertion outside the measured eligible function bodies. Functions skipped by the enumerator do not contribute to the share. The next best action is to run `cupel pseudo` against a scratch copy of a real suite, hand-check the reported functions and units, and record false positives before considering any advice change.

## S10b assertion fingerprints

### Question and result

S6's coverage-only retire advice was correct once in 20; S8's coverage-based `adds-nothing` was wrong for 23 of 24; S6b's mutation-backed retire precision was 0–4%. Their distinguishing evidence was often an exact expected value, boundary, negative case or deliberate pin. This spike records that evidence separately from the unchanged `cupel-spec/1` input.

**Synthetic result:** both node:test and Vitest distinguish a changed expected boundary from a repeat, recognise an exact clone only with K12 similarity at least 0.9, and identify empty/trivial tests. These are observations for review, not retirement or redundancy advice. No `spec/` or `src/engine/` files changed, no dependencies were added, and D5/D14 remain unchanged. No real-repository precision or S6b re-judging has been measured.

### Implementation and use

```sh
# In the project being inspected; all default artifacts are under .scratch/.
node /path/to/cupel/packages/cupel/bin/cupel.mjs assertions --json
node /path/to/cupel/packages/cupel/bin/cupel.mjs assertions --out .scratch/assert/input.json
node /path/to/cupel/packages/cupel/bin/cupel.mjs assertions --input .scratch/assert/input.json --json
```

Live collection runs one pass, writes the ordinary input and `<out>.assertions.json`, and analyses them. `--input` reads that input and its adjacent sidecar without running tests. A missing, unsupported or mismatched sidecar is an error, with no alternate collection path. External collectors, including pytest, are explicitly rejected for live assertion collection.

Both native collectors accept `assertionsOut` and `assertionCap` options; recording is off unless an output path is supplied. Only the first run records assertions, so repeated timing passes do not multiply counts. The default cap is **1,000 records per test**; the attempt count continues beyond the cap and `capHit` is reported. A unit unions the records of its test rows.

The Node preload wraps assertion methods and uses synchronous module hooks for both callable defaults and ESM/CommonJS exports of `node:assert`, `node:assert/strict` and their unprefixed spellings. Strict aliases have strict matcher names. `Assert` instances include their strict/skipPrototype settings in the matcher. Vitest wraps its Chai-backed `to…` matcher methods, including added `expect.extend` methods with that naming convention. Negation and promise modifiers are kept. Wrappers preserve assertion return/throw behaviour and record nested assertions inside throw callbacks as well.

Each attempt records the source site, matcher, expected and actual value fingerprints, normalised subject when recovered, and a triviality flag. The source reader uses the existing lexer, not a new parser dependency; cached source tokens preserve literals while removing whitespace/comments. TypeScript locations and multiline subjects are exercised. Ordinary project source/config files are checked byte-for-byte before and after collection; collector outputs and caches are under `.scratch/`. CodeCrystal's Vitest 4.1.11 installation was used through a read-only node_modules symlink.

### Exact fingerprint and decision definitions

The assertion key is exactly:

```js
JSON.stringify([matcher, subject, expectedFingerprint])
```

- `matcher` is the Node method name (strict aliases normalised), or the Vitest name prefixed by `resolves.`/`rejects.` and `not.` when present. `Assert` instances additionally encode their equality options.
- `subject` is the first/actual argument's source token values joined with single spaces, retaining identifiers, literals and punctuation. For Vitest it is the argument of `expect`. If it cannot be cheaply identified, it is `null`. This is syntax, not dataflow or semantic equivalence.
- `expectedFingerprint` is a JSON string containing a type-tagged value tree. Own string property names are sorted; arrays retain indexed properties and length. Undefined, null, booleans, bigint, numbers (including -0/NaN/infinities), strings, symbols by description, regex source/flags, dates by epoch, maps and sets have explicit tags. Map/set iteration order is retained. Repeated/cyclic object references use traversal indices assigned in canonical traversal order. Accessors are represented without invoking them; `toJSON` is not called. Functions become `["function","[Function]"]`. Strings longer than **256 UTF-16 code units** become `["string-sha256", length, SHA256(UTF16LE bytes)]`; this also distinguishes unpaired surrogate code units. Other objects use their sorted own string properties.
- Node's expected value is its second argument, except `ok`, `ifError` and `fail`, which have no expected value. Vitest uses the single matcher argument, all arguments as an array when there are several, or undefined when absent. Actual values use the same serializer, but **actual values and call sites are not part of the comparison key**.
- A nonempty fingerprint set A is subsumed by B exactly when A is a subset of B. Multiplicity does not affect the set; `assertionCount` still counts attempts.
- `cloneOf` lists equal-set partners whose existing K12 shingle sets have Jaccard similarity at least **0.9**, inclusively. Missing or empty K12 shapes do not qualify. `subsumedBy` and `cloneOf` are sorted ID lists and may be symmetric.
- `uniqueFingerprints` lists keys observed in no other unit. `assertionFree` is true for zero attempts or only these trivial checks: literal `ok(true)`/callable `assert(true)`, positive `toBeDefined` with a non-undefined actual, or positive `expect(x).toBe(x)` with the same identifier/member expression on both sides. A successful `ok(valid)` is **not** considered trivial merely because its runtime value is true. Negated/promise checks are not classified as trivial.
- Missing recordings, failed/skipped tests, recording errors, caps and ambiguous concurrent attribution set `incomplete`; such units receive no subsumption/clone claim and `assertionFree: null`. During overlapping tests the attempts are retained in all active leaf buckets with an explicit ambiguity diagnostic; those counts are not exact per-test counts. They are never presented as conclusive evidence.

The sidecar binds to a deterministic identity of test IDs/unit IDs/statuses, source hashes and K12 shapes. It does not include durations, process IDs or timestamps. It is not a cryptographic provenance or test-source freshness guarantee. The pure analyzer does no I/O, imports no runtime APIs, reads no clock and does not mutate its inputs.

### Tests and coverage boundaries

The three new test files contain **15 passing targeted cases**, covering:

- Both runners: repeat/subset, boundary uniqueness, empty/trivial tests, exact clone, repeated-run sidecar determinism, unchanged input format, and byte-identical project files outside `.scratch/`.
- Node callable assertions, named ESM exports, CommonJS, strict aliases, deep/negative/match/throw/reject methods, Assert instances, caught/uncaught failures and skipped tests.
- Vitest negation, resolves/rejects, custom `to…` matchers, TypeScript locations and multiline subjects.
- Nested assertions in callbacks and explicit incomplete attribution for concurrent tests in both runners.
- Live CLI collection for both runners, JSON/human evidence, missing/mismatched sidecar rejection, caps, grouped units, inclusive K12 threshold, missing records, canonical values, getter avoidance and serializer errors.

Verification commands (cache/temp environment redirected under this worktree's `.scratch/`):

```sh
PATH=/opt/homebrew/bin:$PATH node --test --test-reporter=spec packages/cupel/test/assertions*.test.mjs
PATH=/opt/homebrew/bin:$PATH npm run verify
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm test
```

Final verification: `npm run verify` exited **0** on Node 26.7.0 (repository checks, Node tests, 35 Python tests, and 10 Ruby tests/49 Ruby assertions). The full `npm test` also exited **0** on Node 22.23.3. The 15 targeted S10b cases passed with no skips. `git diff --check` passed. All changes remain uncommitted.

The benchmark also asserts 200 passing tests and exactly 1,000 complete assertion records in every recorded run, and checks that source/config files were not changed. No pytest recording code or tests were added. Chai's non-`to…` assertion dialect, arbitrary custom matcher names, snapshots, isolated `expect` instances, test-context `t.assert`, worker/subprocess assertions, parent-container-only assertions and other Vitest versions were not validated as assertion-recording surfaces. The classifier only describes the supported recorded surface; an empty recording is not proof that a test has no checks through another assertion library. Source helpers/aliases can produce null or generic subjects, and source lexical failures mark the recording incomplete. Functions, local symbols, prototypes and opaque object internals lose identity under the serializer; matching keys therefore do not prove behavioural equivalence. The collector's existing source-map/coverage behavior is not changed.

### Recording overhead: 200-test synthetic suites

Harness: `bench/s10b-assertions.mjs`; raw final samples: `.scratch/s10b-benchmark.json`. Node **26.7.0**, Vitest **4.1.11**, one test file per framework, 200 separately defined tests, five assertions each (equality, deep equality, regex, negative equality and throw). One warm-up pair, then **five measured pairs**, alternating recording-on/off order. The baseline is the **same coverage collector with assertion recording disabled**, not the plain test runner. Elapsed wall time includes subprocess startup, coverage collection, static analysis and, when on, sidecar serialization/write. Runs were sequential; no Cupel verification run was intentionally running during the final benchmark. These are local latency measurements, not memory measurements or a production-suite estimate.

| Runner | Off median | On median | Added time | Ratio | Overhead | Sidecar bytes |
|---|---:|---:|---:|---:|---:|---:|
| node:test | 494.11 ms | 782.27 ms | 288.16 ms | 1.583× | 58.32% | 589,621 |
| Vitest | 847.94 ms | 1,326.34 ms | 478.40 ms | 1.564× | 56.42% | 592,621 |

Raw final samples in milliseconds (pair order):

- Node off: 494.111, 485.455, 509.393, 489.247, 498.405; on: 790.182, 767.879, 798.788, 767.539, 782.273.
- Vitest off: 824.628, 842.668, 849.410, 847.941, 850.683; on: 1303.223, 1341.518, 1328.272, 1326.339, 1308.447.

An earlier implementation measurement had a noisy Node off range of 519.55–2278.14 ms and on range of 804.44–2375.14 ms (medians 604.34/1530.21 ms, 2.532×). Its Vitest medians were 855.61/1322.44 ms (1.546×). The raw earlier data remain in `.scratch/s10b-benchmark-first.json`. After fixing nested callback recording, the final complete measurement above was taken; the earlier noisy result is not discarded as proof of a stable 2.5× cost. Neither measurement establishes an overhead bound.

### What pytest support needs

1. Extend the existing `pytest_runtest_setup`/`pytest_runtest_logreport` buckets with the same sidecar, cap, node-ID-to-unit mapping and incomplete diagnostics, keeping the public input unchanged.
2. Record **successful** Python `assert` executions. Failure formatting alone cannot do this. Add a version-tested integration with pytest assertion rewriting or an in-memory AST/import transform; preserve evaluation exactly once, short-circuiting, chained comparisons, messages, exception behaviour and original source locations. Never write transformed project source or bytecode outside `.scratch/`.
3. Define matcher/expected extraction for Python comparisons, truth tests, membership/identity, `pytest.raises`, `pytest.warns` and `pytest.approx`; identify unsupported constructs explicitly. Add standard-library type-tagged canonicalization and matching string-hash encoding.
4. Cover fixtures/teardown, parametrized rows, skipped/failed tests, nested assertions and xdist/async attribution, with determinism, semantic-preservation, unchanged-project tests and a separate 200-test overhead measurement.

No owner decision is needed to review this uncommitted spike. **Next best action:** run it on a scratch copy of the S6b/S8 false-positive samples and hand-check the observed subsumption pairs against their expected values and subjects before considering any further use of this signal. No decision to restore retire/`adds-nothing` advice is implied.

### Files changed for S10b

- `packages/cupel/src/analysis/assertions.mjs`
- `packages/cupel/src/collect/assertions/value.mjs`
- `packages/cupel/src/collect/assertions/source.mjs`
- `packages/cupel/src/collect/assertions/recorder.mjs`
- `packages/cupel/src/collect/assertions/node.mjs`
- `packages/cupel/src/collect/assertions/vitest.mjs`
- `packages/cupel/src/collect/assertions/sidecar.mjs`
- `packages/cupel/src/collect/node/hook.mjs`
- `packages/cupel/src/collect/node/index.mjs`
- `packages/cupel/src/collect/vitest/setup.mjs`
- `packages/cupel/src/collect/vitest/index.mjs`
- `packages/cupel/src/cli/assertions.mjs`
- `packages/cupel/src/cli/main.mjs`
- `packages/cupel/test/assertions.test.mjs`
- `packages/cupel/test/assertions-collect.test.mjs`
- `packages/cupel/test/assertions-runners.test.mjs`
- `bench/s10b-assertions.mjs`
- `plans/spikes/s10/README.md` (this section only)
