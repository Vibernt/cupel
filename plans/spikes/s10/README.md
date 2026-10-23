# S10a: extreme mutation for pseudo-tested functions

## Boundary

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
