# Ordinary Jest real-project acceptance

Date: 2026-10-26. **Passed** against the installed private release candidate.
This is the complete original Jest lane of a genuine pinned external project.
It is ordinary full guard, with no selective profile, substituted test subset,
resolver change, saved-input guard or disabled mutation.

## Subject and candidate pins

Subject:
[`jest-community/jest-junit@f33e1f2c5bfb80e300cb5ed5734503d5d17f8ef0`](https://github.com/jest-community/jest-junit/tree/f33e1f2c5bfb80e300cb5ed5734503d5d17f8ef0),
Git tree `85ebfcbeaac3f3c18fec50af4565de5bd1177ddd`.
All **36 original tracked files** match their pinned Git blob IDs and final
SHA-256 hashes. The only temporary original-lane edit was one assertion in
`__tests__/getOptions.test.js`; it was restored and final `git diff` is empty.

The tested private npm archive SHA-256 is
`c17c2e3814015e277c882addeeb0e1416004fe78051b87360f6500594435c15f`.
The separately copied installed product is pinned to
`sha256:35d1ab98904e297eec616fec67b5f55ec38d55f294ee8be28760ffb3cf0ad5d9`,
with **185 product source/schema files**, on Node **26.7.0**. Its producer and
archive hashes match again after acceptance. The old `50ba...` product was used
only for historical setup preflight; none of the real acceptance runs used it.
No Cupel product source or installed product was changed during acceptance.

## Original setup and complete lane

A metadata-only privacy/type check examined the entire pinned Git tree before
source acquisition: no credential paths, symlinks, submodules or opaque entries.
Credential-disabled HTTPS Git fetched the exact commit into ignored scratch.
The owner's explicit setup approval permitted the original locked dependency
closure; lifecycle scripts were disabled and npm user/global configuration
files were empty isolated files. No alternate dependency version was used.

The original lock contains **322 package entries**; **298 exact entries** were
installed and **24 platform-optional entries** were omitted by npm. Independently
verified public tarball integrity covers **277 original-lock SRI entries** plus
**21 exact registry-version metadata/SRI pins** where the original lock omitted
integrity. The original manifest and lock were unchanged:

| File | SHA-256 |
| --- | --- |
| package.json | `2a0f74797647d82c98b5079b476e97b0c751895137a6ff22f8a7f18ea1fdffaf` |
| package-lock.json | `630b859874b1008cb66cd6fb4e64f956e0ec0a37688afd1f842f0ed46ba20237` |

The original manifest/lock pins `jest`, `jest-circus`, `jest-environment-node`
and `babel-jest` to **30.2.0**. Original configuration remains one project entry,
Node environment, `transform:{}`, project setup, default plus self reporter,
and all configured test files. The original `CLAUDE.md` requires
`NODE_OPTIONS=--experimental-vm-modules`; it was explicitly preserved for both
ordinary Jest and Cupel because setup imports `libxml2-wasm`. Tests are CommonJS.
Execution used a minimal explicit environment with scratch `TMPDIR`, no inherited
developer credentials and no `HOME` override. The setup phase initially supplied
a private `HOME` before this was corrected; later execution omitted it entirely.
No secret content was read.

The **entire original configured inventory** is:

- `__tests__/buildJsonResults.test.js`
- `__tests__/getOptions.test.js`
- `__tests__/getTestSuitePropertiesPath.test.js`
- `__tests__/testResultProcessor.test.js`

Original Jest passed **51/51 tests in all 4 files**, with zero skipped, pending
or failing rows. Installed Cupel's two fresh collection runs each passed all
51 rows, and every canonical ID/status matches ordinary Jest. Full row inventory,
effective inputs, configuration and original file hashes are retained as evidence.
Cupel analyzed **10 sources**, covering **435/469 lines (92.75%)**.

## Frozen policy and mutation scope

Before the first Cupel baseline, acceptance policy preserved `include:["**"]`,
no exclusions, built-in critical words, coverage ratchets, mutation no-loss,
all three mutation switches, **200 mutants / 300 seconds**, and seed `20261021`.
It explicitly classified two original public output-path API sources as critical:

- `utils/getOutputPath.js`
- `utils/replaceRootDirInPath.js`

These sources implement configured output-file behavior and `<rootDir>` path
mapping. Analysis and test collection covered the whole original lane. Mutation
covered these **declared critical sources**; it does not claim every project
function or every possible mutant was exercised.

All **11 generated critical sites** were valid and executed, with zero invalid
or omitted sites and no sampling. Baseline killed **11/11**, including **two
body-replace mutants**, with credit assigned to original behavioral assertions.

## Live positive and negative controls

| Required check | Result |
| --- | --- |
| Unchanged installed CLI `guard --base <original exact commit> --runs 2` | Exit **0**, `guard.pass:true`; no coverage or critical-mutation loss |
| One existing assertion weakened while retaining its call and title | Original complete Jest lane still **51/51 passed** |
| Same installed live Git guard after weakening | Exit **1**, `guard.pass:false`; exactly **one critical kill lost** |
| Production source hashes and per-test production coverage | Identical before/after weakening |
| Original assertion restored | All 36 original tracked files restored; final Git diff empty |
| Fresh installed MCP unchanged/weak guards | Both normal results, `isError:false`; entire JSON reports exactly equal their CLI controls |

The weak assertion changes only
`expect(newOutput).toBe(outputPath)` to
`expect(newOutput).toBe(newOutput)` in the existing test
`replace <rootDir> > should not replace when output has no <rootDir>`.
The lost mutant is
`utils/replaceRootDirInPath.js:9:7:return-value:b74324dd`.
Its original credited killer is that same behavioral test. Fresh weakened
collection/mutation records **10 killed / 1 survived**, with identical original
source hashes and per-test production coverage.

The CLI guard logs `confirming 1 survivors` and completes the negative verdict.
Supplemental invocation of the **same pinned installed** `confirmSurvivors`
records **two completed confirmation-loop iterations** through its built-in
caller metrics (`factHits:2`); the mutant survives both. This observed supplemental
count is distinguished from the CLI's own invocation log, whose JSON does not
contain a confirmation-count field.

MCP checks performed fresh live Git collection and mutation through local stdio.
They used no retained snapshot or saved input. The negative guard is a normal
tool result, not an environment/tool error.

## Separate pristine-source controls

A separate supplemental copy preserves the original source/config and adds two
explicit source-hash pin tests to the two existing relevant test files. Its
**53 tests = 51 original + 2 controls**, still in four configured files. These
added tests are excluded from the original-lane acceptance count.

Ordinary Jest and two-run installed collection pass all 53 rows; all **11/11
critical mutants** are still killed by behavioral tests and source-pin tests
receive **zero killer credit**. Two direct runs through the pinned installed
Jest mutant runner additionally observe a pin **passing while an original
behavioral test fails** for one mutant in each critical source. Source bytes
remain unchanged. The runner serves mutant text in process memory before
transformation, disables disk cache, and writes no mutant-text source files.

## Costs, reproducibility and limits

These are measured **whole-call wall times**, not speedup measurements. Setup,
ordinary Jest, two-run collection/mutation and live guards perform different work.
Memory was not measured.

| Operation | Wall time |
| --- | ---: |
| Exact source fetch / checkout | 1,015 / 733 ms |
| Original locked `npm ci` (registry pin preparation separate) | 3,164 ms |
| Ordinary original / weakened Jest lane | 1,772 / 804 ms |
| Installed baseline / weakened two-run report with mutation | 8,414 / 7,946 ms |
| Installed unchanged / weakened live CLI guard | 16,074 / 18,055 ms |
| Supplemental two-confirmation invocation | 2,344 ms |
| Fresh unchanged / weakened live MCP guard | 16,746 / 19,261 ms |
| Supplemental source-pin ordinary / report / direct probes | 871 / 8,401 / 1,756 ms |

The reusable offline helpers are in `scripts/acceptance/jest/`. Their **three
smoke tests pass on Node 26.7.0 and Node 22.23.3**, covering missing-row rejection,
complete duplicate/status identity handling, preserved subprocess failure, and
required explicit subject/tool pins with wrong-artifact rejection. Identity ordering uses deterministic code-point comparison. Repository
guardrail checks pass. The real project, dependencies, network/setup ledger,
raw process logs, patch, controls and **190 evidence files** remain ignored under
`.scratch/jest-real-acceptance/`. Machine-readable tracked results are in
`plans/results/2026-10-26-jest-acceptance.json`; the raw evidence manifest SHA-256
is `77d8e145b84918324e71ff1565439e94f642deead7cdc04ca399713c8252ba6a`.

This proves the narrow ordinary Jest lane on this pinned real project and
candidate. It does not establish hosted CI enforcement, other Jest versions,
native ESM test files, arbitrary third-party transforms, selective execution,
publication readiness or a speedup. No whole-project function-mutation sweep
was run; the declared critical scope and caps are explicit above.

Next best action: mark the narrow real-Jest gate accepted for this exact private
candidate, then complete the remaining final review/artifact and publication
approval gates. Keep hosted enforcement unadvertised until separately accepted.
