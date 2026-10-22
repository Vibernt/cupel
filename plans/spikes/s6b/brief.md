You are a careful senior test reviewer judging test-retirement advice. Do not modify any file except the one output file named below. Do not run test suites. Do not commit.

# Task: judge 48 "retire" suggestions (spike S6b)

Cupel ran on Vibernt Assay's Node test suite. The snapshot is at /Users/vid/cupel/.scratch/assay-base, at HEAD 5a5a1313; treat it as read-only. Cupel advised retiring 48 tests under its strict rule. Each of these tests:
- is not critical, and passed;
- has no line that no other test covers, confirmed by re-running it in its own process;
- had every mutant on its own lines run (targeted mutation), and none of those mutants was caught by this test alone.

The list is /Users/vid/cupel/.scratch/s6b/retire-48.json. Each entry gives:
- `unit`: the test id, `<file>::<full name>`, with ` > ` between describe levels;
- `ownLines`;
- `ownLineMutants`, `ownLineMutantsDetected` and `ownLineMutantsSurvived`;
- `topOverlap`: the three tests that share most of its lines.

Note that mutation only covers the operators Cupel generates (comparison flips, boundaries, boolean and arithmetic swaps, return values, removed calls) on the lines the test runs. A test can still protect something mutation doesn't model, such as an exact string, a structure, a registry's completeness, a file on disk, or an ordering.

## Your job
For each entry, read:
- the test itself;
- the overlapping tests;
- the code they exercise.

Then judge whether a careful engineer would agree to retire it:
- **`correct`:** everything it asserts is already asserted elsewhere (name where). Removing it loses nothing.
- **`wrong`:** it asserts something no other test asserts. Say what, concretely.
- **`debatable`:** reasonable reviewers could differ. Say why.

Also give a `cause` for every `wrong` or `debatable` entry:
- `assertion-outside-mutation`: it protects something the mutation operators don't model;
- `weak-overlap-tests`: the overlapping tests run the lines but assert less, and mutation missed it;
- `deliberate-pin`: a freshness check, registry check or policy check;
- `critical-missed`: a security or trust-boundary test the tier rules missed;
- `other`.

## Output
Write a JSON array, in input order, of `{ "unit", "judgement", "cause" (or null), "evidence" }`. The evidence is one or two sentences naming the specific assertions you compared, and where they are already asserted. Write it to OUTPUT_FILE.

Finish with the counts per judgement and per cause.
