# S6b: Is retire advice credible once it requires mutation proof (D5)?

## Question

D5 allows "retire" only for a test that:
- is not critical, ran and passed;
- has no unique line after a per-process re-check;
- had every mutant on its own lines run, with none caught by it alone.

S6 judged the coverage-only rule (right 1 time in 20). Is the strict rule credible?

## Data and method

- **Run:** the M3 end-to-end run on Vibernt Assay ([results](../results/M3-assay-end-to-end.md)).
  - 1,465 retire candidates were re-checked.
  - 102 got complete targeted mutation, with whole units taken smallest first, 882 mutants in all.
  - **48 were advised `retire`**, all by the mutation path.
- **Judges:** two independent judges from different model families judged all 48. Each read the test, its three most-overlapping tests and the code, from the same brief ([`s6b/brief.md`](s6b/brief.md)).
  - Judge A: Codex `gpt-6-astra`.
  - Judge B: Claude Sonnet.
  - Neither saw the other's answers.
- **Judgements:**
  - `correct`: everything it asserts is asserted elsewhere;
  - `wrong`: it asserts something no other test does;
  - `debatable`.
- **Causes:** `assertion-outside-mutation`, `weak-overlap-tests`, `deliberate-pin`, `critical-missed`, `other`.

## Results

| | Judge A (Codex) | Judge B (Claude) |
|---|---|---|
| correct | **0** | 2 |
| wrong | 46 | 35 |
| debatable | 2 | 11 |

- **Agreement:** exact on 37 of 48. Both say wrong on 35; one says wrong and the other debatable on 9; both say debatable on 2. **No retire was judged correct by both.** Each of the two that judge B called correct, judge A called wrong.
- **Precision of retire advice:** 0 % by agreement, and at most 4 % (2 of 48) if any single judge's `correct` counts.

| Cause (non-correct verdicts) | Judge A | Judge B |
|---|---|---|
| deliberate-pin (registry, completeness, policy checks) | 17 | 14 |
| assertion-outside-mutation (exact strings, structures, orderings) | 19 | 8 |
| weak-overlap-tests (overlap tests run the lines, assert less) | 10 | 23 |
| critical-missed | 2 | 0 |
| other | 0 | 1 |

Full judgements: [`s6b/judge-codex.json`](s6b/judge-codex.json) and [`s6b/judge-claude.json`](s6b/judge-claude.json).

## Why the strict rule still fails

1. **Mutation models the wrong faults for these tests.** Cupel's operators flip comparisons, boundaries, booleans and arithmetic, replace return values and remove calls. They never change a string literal, an object key, an array element, or the order of a list. A test whose unique value is pinning exact text, shape or order can never earn a unique kill, so it looks redundant.
2. **Deliberate checks are invisible to both coverage and mutation.** Tests such as "every registered name is still read somewhere in src/" or "the five published legal texts are the only source" read files or registries. Mutating `src/` lines does not exercise what they protect, and the brittleness detector did not flag them.
3. **The overlap tests run the code but assert less.** A unique kill needs a mutant the overlap tests miss. When the mutant set is coarse, every mutant gets caught by the broader tests through some side effect, while the candidate's precise assertion goes unmeasured.

## Verdict

**No. Retire advice is not credible, even with D5's mutation proof.** Retire precision is 0–4 % on 48 suggestions, judged by two independent model families. With S6 (coverage only: 1 in 20) and S8 (coverage "adds nothing": 23 of 24 wrong), three separate measurements show that deterministic signals in their current form cannot tell a redundant test from a test with unique assertions.

## Options

- **A. Recommended for v1. Turn retire advice off.**
  - Cupel never advises `retire`.
  - Every unit that passes the D5 evidence becomes a review hint, `no-unique-evidence`, ranked by evidence strength and cost, and worded as "a person may review", never "remove".
  - `check` likewise never says `adds-nothing`; it says `no-unique-evidence (unverified)`.
  - Cupel's value rests on what the spikes support:
    - the guard (S4);
    - mutation gaps on critical code (S3: 54 % critical mutation score on Assay);
    - rewrite advice for brittle pins;
    - consolidating near-identical siblings (S6: 8 of 11 correct);
    - prioritised runs.
- **B. A research spike (S10) before deciding retire's future:**
  - add string, object-key, array-element and ordering operators;
  - treat tests that read source, doc or registry files as deliberate checks, never candidates;
  - mutate the assertions' expected values to find tests whose assertions are subsumed by others;
  - re-run S6b on the same 48 plus a fresh draw.

  Only if two judges then agree on high precision (for example 80 % or more) does retire come back, still behind a person's approval.
- **C. Keep retire as is, behind approval.** Not recommended: 0–4 % precision would cost reviewers' trust in everything else Cupel says.

## Caveats

- Both judges are models, and no person checked them. They agree strongly (37 of 48 exact), and the direction matches S6 and S8.
- **Sample:** one repository, mostly agent-written, and only the 48 smallest candidates (whole units, smallest first).
- **Mutation was limited:** to Cupel's current operators, within the time caps.
