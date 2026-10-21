# Cupel spec, version `cupel-spec/1`

This is the normative definition of Cupel. Every implementation, in any language, must produce the reports this spec defines, and must pass every case in [`conformance/`](conformance/).

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Rule identifiers such as **T3** are stable. Every engine rule (prefixes I, T, S, A, P, C, G, L, R, E) has at least one positive and one negative conformance case. Collector rules (prefix K) are proved by the adapter conformance kit. A reference such as "spike S6" points to [`plans/spikes/`](../plans/spikes/), never to a rule.

The clarifications in this spec record the readings an independent implementation needed (see `packages/cupel/ENGINE-NOTES.md`). Where the spec once allowed two readings, it now names the one that protects tests or fails the guard.

The evidence behind each rule is in [`plans/spikes/`](../plans/spikes/), and the decisions in [`plans/DECISIONS.md`](../plans/DECISIONS.md).

## 1. Versioning

- The spec version string is `cupel-spec/<major>` or `cupel-spec/<major>.<minor>`. This document is major 1.
- Additive changes (new optional fields, new hints, new reason codes) bump the minor. Anything that changes an existing report for the same input bumps the major.
- An implementation of major 1 MUST accept inputs and configs whose `spec` is any `cupel-spec/1` or `cupel-spec/1.<n>`.

## 2. Parts

| Part | What it is |
|---|---|
| **Input** | What collectors and importers hand the engine: tests, results, coverage, mutation outcomes, brittleness findings, body shapes. Schema: [`schemas/input.schema.json`](schemas/input.schema.json) |
| **Config** | The user's `cupel.json`. Schema: [`schemas/config.schema.json`](schemas/config.schema.json) |
| **Arguments** | Per-command values not stored in the input: changed lines, the tests to check, approvals, a timestamp |
| **Engine** | A pure function: (command, input or inputs, config, arguments) → report and exit code. It does no I/O, reads no clock and uses no randomness |
| **Report** | The engine's output. Schema: [`schemas/report.schema.json`](schemas/report.schema.json) |

## 3. Data model

### 3.1 Line sets

A **line set** is a string of 1-based line numbers and inclusive ranges, separated by commas, for example `"1-3,7,10-12"`. The empty string is the empty set.

- Inputs MAY list lines in any order and MAY overlap.
- Reports MUST use the canonical form: ascending, with overlapping or adjacent ranges merged, and a single line written without a range (`"7"`, not `"7-7"`).

### 3.2 Sources

`sources` maps each source path (relative to the repository root, `/`-separated) to:
- `coverable`: the line set of coverable lines, by the line rule (K1);
- `hash`: optional, a content hash. Guard uses it to tell whether a source changed (G4).

### 3.3 Tests, units and rows

- Each entry in `tests` is one **test id**: a single executed test, including one row of a parametrized or looped test. Ids are stable strings chosen by the adapter (K10).
- Each test belongs to a **unit**, which is its `unit` field or, when that is absent, its own id. A unit is one test definition. All test ids of a unit are its **rows**.
- **The unit of advice is the unit, never a single row.** Rows of a unit MUST share `file`.
- A test's `status` is `passed`, `failed` or `skipped`. A unit is **failed** if any row failed; otherwise **skipped** if every row was skipped; otherwise **passed**.
- `kind` is `unit` (default) or `e2e`. `e2e` marks end-to-end or browser tests whose coverage cannot be attributed reliably.
- `spawnsInterpreter: true` marks a test that starts another interpreter, whose coverage the per-test method cannot see (spike S2).

### 3.4 Coverage

- `coverage.granularity` is `test` or `file`.
- At `test` granularity, `coverage.byTest` maps each test id to the lines it covered during its own run, per source. At `file` granularity, `coverage.byFile` maps each test file to the lines its run covered.
- `coverage.setup` maps each test file to lines covered outside any test: module loading and file-level `before`/`after` hooks.
- `coverage.rechecked` lists the units whose coverage was confirmed by running each in its own process (K4).

### 3.5 Mutation

`mutation.mutants` lists mutants, each with:
- `id`, unique and stable for the same source text and operator site;
- `source` and `line`;
- `operator`;
- `status`, which is `killed`, `survived`, `timeout`, `no-coverage` or `error`;
- `killedBy`: the test ids whose run failed or timed out on this mutant.

A mutant is **detected** when its status is `killed` or `timeout`.

`mutation.targeted` lists the units for which every mutant generated on their own lines was run, without sampling (K6).

### 3.6 Brittleness findings and shapes

- `brittleness` lists findings `{ test, kind, line?, deliberate? }`. `kind` is `source-text`, `css-class`, `doc-wording` or `file-snapshot`. `deliberate: true` marks a pin that is intended, such as a freshness check of a generated file or a provenance hash (spike S6).
- `shapes` maps a unit id to its **shape**: a set of integer shingle hashes of the unit's body (K12).

### 3.7 Arguments

| Argument | Used by | Meaning |
|---|---|---|
| `changed` | plan | Changed lines per path, as line sets. A path with the empty line set counts as changed in full |
| `tests` | check | The units or test ids to check |
| `approvals` | guard | A list of `{ action: "remove" \| "downgrade", id, by }`. Approvals come from a person, outside the agent's write scope (L5) |
| `generatedAt` | all | When present, copied into the report. The engine never reads a clock |

## 4. Input integrity

- **I1** The input MUST validate against `input.schema.json`, and every config against `config.schema.json`. Otherwise the engine reports the diagnostic `invalid-input` (or `invalid-config`) with the JSON path, and exits 2.
- **I2** Every test id referenced in `coverage`, `mutation.mutants[].killedBy`, `brittleness`, and argument `tests` MUST exist in `tests`. Every unit id in `coverage.rechecked`, `mutation.targeted` and `shapes` MUST be a unit. Rows of a unit MUST share `file`, and test ids MUST be unique. Otherwise the diagnostic is `unknown-test`, `unknown-unit`, `unit-spans-files` or `duplicate-test`, and the exit code is 2.
- **I3** Every line in a coverage or mutation entry MUST be a coverable line of a source in `sources`, and every range (in `sources`, coverage, mutation and argument `changed`) MUST have start ≤ end. Otherwise the diagnostic is `line-not-coverable`, `unknown-source` or `bad-range`, and the exit code is 2.

**Diagnostics.**
- There is one diagnostic per problem, with `path` as a JSON pointer into the document when there is one.
- Diagnostics are sorted by code, then path, then test, then message, with exact duplicates dropped.
- When a command has two inputs, `message` starts with `base:` or `head:`.
- Schema problems (I1) stop the run before I2 and I3 are checked.
- Mutant ids MUST be unique within an input (`duplicate-mutant`).
- A tier word with no tokens would match every path, so it is an invalid config (`invalid-config`).
- Invalid arguments are `invalid-arguments`; `check` without tests is `missing-argument`; a command without its input or inputs is `missing-input`. Approvals need a non-empty `by`.
- Each of these exits 2.

## 5. Tiers

**Matching rules.**
- **Tokens.** A path or title is split into **tokens** at every character that is not a letter or digit, and at every lowercase-to-uppercase boundary. Tokens are lowercased.
- **Words.** A word (for example `sign-in`) is split the same way. It **matches** when its tokens appear consecutively in the text's tokens: each must equal the corresponding token, except the last, which only needs to be a prefix (so `migrat` matches `migrations`).
- **Globs.**
  - `**` matches zero or more whole path segments.
  - `*` matches any run of characters except `/`.
  - `?` matches one character except `/`.
  - Every other character matches itself.
  - A glob must match the whole path, and `a/**` also matches `a`. `[` and `]` are literal.
  - A `**` that is not a whole path segment (as in `src/**.ts`) crosses `/` in critical globs and acts as `*` in minor globs, so an unclear glob always errs towards protection.
- Letters and digits are Unicode letters and decimal digits; strings compare by code point everywhere in this spec.

**Critical sources.** A source is **critical** when its path matches a `tiers.critical` glob, or when its path matches a path word.

**Default word lists** (D4), replaced by `tiers.pathWords` and `tiers.titleWords`, or extended by `tiers.extraPathWords` and `tiers.extraTitleWords`:
- Path words: `auth`, `permission`, `tenan`, `token`, `secret`, `egress`, `billing`, `quota`, `migrat`, `backup`, `delet`, `public-api`, `credential`, `crypto`, `leak`, `unsafe`, `sign-in`, `login`, `security`, `isolat`, `sandbox`, `privacy`, `integrity`, `redact`, `inject`, `travers`, `harden`, `admission`, `budget`.
- Title words: `negative`, `security`, `forged`, `tamper`, `refuse`, `permission`, `token`, `secret`, `credential`, `unsafe`, `leak`.

**Rules.** A unit's tier is decided by the first rule that applies, and `tierReason` names it:

- **T1** **Tag.** If any row carries a tier tag (`critical`, `standard` or `minor`, matched exactly, case included) in `tags`, the unit takes the most protective tag present (critical over standard over minor). Reason: `tag`. A tag can lower a tier below what T3 to T5 would give; between base and head that is a downgrade, which G8 catches, and T8 still protects any unit that covers a critical source.
- **T2** **Unknown tag.** A tag other than the three tier tags produces the diagnostic `unknown-tag` (severity `error`) naming the test id. It does not change the tier. `label` exits 1 when any `unknown-tag` diagnostic exists; other commands report it and are otherwise unaffected.
- **T3** **Path rule.** If the unit's file matches a `tiers.critical` glob, the tier is `critical`. Reason: `path-rule`.
- **T4** **Word.** If a path word matches the unit's file, or a title word matches the `name` of any row, the tier is `critical`. Reason: `critical-word`.
- **T5** **Unique critical lines.** If the unit has at least one unique line (S2) in a critical source, the tier is `critical`. Reason: `unique-critical-lines`.
- **T6** **Minor path rule.** If the unit's file matches a `tiers.minor` glob, the tier is `minor`. Reason: `path-rule`.
- **T7** **Default.** Otherwise, the tier is `standard`. Reason: `default`.
- **T8** **Protected.** A unit is **protected** when its tier is `critical`, or when its own lines (S1) include any line of a critical source. A protected unit is never advised retire (A10).

## 6. Signals

For a unit `u` with rows `R(u)` in test file `f`:

- **S1** **Own lines.** `own(u)` is the union of the rows' covered lines (`coverage.byTest`), minus `coverage.setup[f]`. Lines are compared as (source, line) pairs. At `file` granularity, `own(u)` is the file's coverage (`coverage.byFile[f]`) plus any rows' coverage, minus `coverage.setup[f]`; it feeds protection (T8), plan (P2) and check, never uniqueness.
- **S2** **Unique lines.** `unique(u)` is `own(u)` minus the own lines of every other unit, minus the setup lines of every test file. `uniqueLines` is its size. A line that only loads in some file is never unique evidence.
- **S3** **Kills.**
  - `kills(u)` is the number of detected mutants whose `killedBy` contains a row of `u`.
  - `uniqueKills(u)` is the number of detected mutants whose `killedBy` is non-empty and contains only rows of `u`.
- **S4** **Duration.**
  - A row's duration is the median of its `durationsMs`: the middle value, or for an even count the mean of the two middle values rounded down. A row with no durations has duration 0.
  - `durationMs(u)` is the sum of its rows' durations.
  - `runs(u)` is the smallest number of durations recorded for any row (0 when a row has none).
- **S5** **Brittleness.** The unit's findings are its rows' findings. `brittle` is the sorted list of their distinct kinds. The unit is **pinned** when it has a finding with `deliberate` not true, and **deliberately pinned** when all its findings are deliberate.
- **S6** **Similarity.**
  - `shape(u, v)` is the Jaccard index of the two shapes, each taken as a set: the size of their intersection over the size of their union, 0 when either shape is missing or both are empty.
  - `lineJaccard(u, v)` is the same index over `own(u)` and `own(v)`, 0 when both are empty.

## 7. Advice

Each unit gets exactly one `advice`: `keep`, `consolidate`, `rewrite`, `move-to-check`, `retire` or `none`. It also gets ordered `reasons` and sorted `hints`.

**Advice rules.** Consolidation groups (A9) are computed first. Then rules are tried in order and the first that applies decides the advice. "Critical" in A6 and A9 means tier `critical`. Thresholds compare exactly against the decimal as written (`0.8` means 8/10), never as binary floating point.

- **A1** A **failed** unit gets `none`, reason `failed`. A failing test's coverage and kills are not trusted.
- **A2** A **skipped** unit gets `none`, reason `not-run`.
- **A3** A **pinned** unit gets `rewrite`, with reasons `brittle:<kind>` for each kind in `brittle` (deliberate kinds included), in sorted order.
- **A4** A **deliberately pinned** unit (at least one finding, all deliberate) gets `move-to-check`, reason `deliberate-pin`.
- **A5** A member of a consolidation group (A9) gets `consolidate`, reason `same-shape`, with `group` set to the group id.
- **A6** **Slow and low value.** A passed unit that is not critical, with `runs(u)` ≥ `advice.minRuns`, `durationMs(u)` ≥ `advice.slowMs` and `uniqueLines` < `advice.lowValueUniqueLines`, gets `rewrite`, reason `slow-low-value`. This needs `test` granularity.
- **A7** **Keep with evidence.** A unit whose tier is `critical`, or with `uniqueLines` ≥ 1, or with `uniqueKills` ≥ 1, gets `keep`. Its reasons are those that hold, in this order: `critical`, `unique-lines`, `unique-kills`.
- **A8** **No evidence.** A unit with an empty `own(u)` gets `none`, with hint `no-coverage-evidence`. Covering nothing is not the same as being worth nothing (spike S6).
- **A10** **Retire.** A unit selected by the retire pass gets `retire`, with reason `no-unique-lines`, plus `no-unique-kills` (mutation path) or `duplicate-of` (duplicate path; `duplicateOf` names the other unit).
- **A11** **Otherwise** the unit gets `keep` with hint `no-unique-coverage-unverified`. This is a review hint, never advice to remove.

**Hints.** These attach whatever the advice:
- `spawns-interpreter` when any row has `spawnsInterpreter`;
- `low-evidence` when any row has `kind: "e2e"`;
- `retire-conflict` when A10 rejected the unit only because of joint safety.

**A9 Consolidation groups.**
- **Which units can join.** Eligible units have status passed and no brittleness finding (deliberate or not), and are measured at `test` granularity, with `advice.consolidate` true.
- **When two units are linked.** Two eligible units of the same file are linked when `shape` ≥ `advice.shapeSimilarity`, `lineJaccard` ≥ `advice.lineJaccard`, and both or neither are critical.
- **Groups.** Groups are the connected components of two or more units. They are numbered `g1`, `g2` and so on, in ascending order of each group's smallest unit id. Within a group, units are listed in ascending id order.
- **What is ignored.** "Own lines are a subset of a sibling's" is not a consolidation signal (spike S6).

**A10 Retire eligibility and the retire pass.**

A unit is a **retire candidate** when all of these hold:
- it is not protected (T8) and has no `e2e` or `spawnsInterpreter` row;
- it is passed, at `test` granularity, with a non-empty `own(u)` and `uniqueLines` = 0;
- it is listed in `coverage.rechecked`;
- and either:
  - the **mutation path:** it is listed in `mutation.targeted` and `uniqueKills` = 0; or
  - the **duplicate path:** another unit `v` exists with `shape(u, v)` ≥ `advice.duplicateShape` and `own(v)` ⊇ `own(u)`.

Missing mutation data is never "no kill".

Only units that reach A10 (no earlier rule applied) are candidates. A failing test's coverage and kills are not trusted (A1), so the pass counts **passed units only** as remaining coverage, remaining killers and duplicate partners.

**The retire pass** keeps retiring jointly safe:
1. Sort candidates by `durationMs` descending, then by id ascending.
2. Take each candidate in turn and accept it only if, after removing it and every unit accepted before it:
   1. the own lines of the remaining passed units, plus the setup lines of test files that keep at least one unit, still include every line in the own lines of all passed units;
   2. every detected mutant that had a passed killer still has a `killedBy` row in a remaining passed unit;
   3. for the duplicate path, at least one qualifying passed `v` remains, for this candidate and for every duplicate-path candidate accepted before it.

   A candidate that fails only these conditions gets hint `retire-conflict` and falls through to A11.
3. Accepted candidates get `retire`. A candidate qualifying by both paths gets reasons `no-unique-lines`, `no-unique-kills`, `duplicate-of`. `duplicateOf` is the smallest qualifying `v` id still present after the pass.

**A12 File granularity.** At `file` granularity, these do not apply:
- unique lines and unique kills for units (reported as `null`);
- A5, A6 and A10;
- T5.

Units that reach A7 or later get `keep` with hint `file-granularity`, unless they are critical, in which case they get `keep` with reason `critical` and no hint. A8 does not apply. `files` appears only at `file` granularity, sorted by file. The report's `files` list each test file's `uniqueLines`. A file with 0 gets hint `file-no-unique-coverage`.

## 8. Plan

- **P1** **Without `changed`:** `mode` is `full`. Units are ordered in the buckets `critical`, then `standard`, then `minor`. Within a bucket they are ordered by `durationMs` ascending, then id ascending.
- **P2** **With `changed`:** `mode` is `changed`. Buckets:
  - `critical`: all critical units;
  - `affected`: non-critical units whose test file is a changed path, or whose own lines or file setup lines intersect the changed lines;
  - `rest`: the other standard units.

  Minor units that are not affected are left out of the order and listed in `skipped`. Ordering within buckets is as in P1.
Failed and skipped units are planned like any other. A test file counts as changed when any `changed` entry names it, whatever its lines.
- **P3** `expectedMs` is the sum of `durationMs` over the ordered units. Each order entry is `{ id, bucket, durationMs }`.

## 9. Check

`check` answers, for each unit named in argument `tests` (a test id names its unit):

- **C1** `adds-value` when the unit is critical, or has `uniqueLines` ≥ 1, or `uniqueKills` ≥ 1.
- **C2** `adds-nothing` otherwise. `extend` names the other unit (of any status) with the largest overlap of own lines (ties: smallest id), or is `null` when nothing overlaps. At `file` granularity only critical units add value.
- **C3** `weakens` when a `base` input is given, the unit exists in both, and its own lines at head do not include its own lines at base, or a mutant it detected at base (present at head by id) is not detected by it at head. `lost` lists the lost lines (line sets per source) and mutant ids. A head mutant counts as detected by the unit when it is detected and its `killedBy` names a head row of the unit. When head has no `mutation` data, every mutant the unit detected at base counts as lost, as in G6.
- **C4** `fails` when the unit is failed, and `not-run` when it is skipped. These take precedence over C1 to C3, which take precedence in the order C3, C1, C2.

Verdicts are listed once per unit, in ascending unit id order. Each entry lists `brittle` kinds; `extend` appears only with `adds-nothing`, and `lost` only with `weakens`. `check` exits 0 when every verdict is `adds-value`, and 1 otherwise.

## 10. Guard

`guard` compares a `base` input with a `head` input under one config. There is no rule G2. Approvals match unit ids exactly.

- **G1** **Runtime.** If `runtime.name` or `runtime.version` differs between base and head, the engine reports the diagnostic `runtime-mismatch` and exits 3. Coverage differs slightly between runtime versions (spike S2), so guard never compares across them.
- **G3** **Head passes.** The check `head-passes` fails when any unit at head is failed.
- **G4** **Coverage never falls.** Covered lines are every line in any row's coverage (failed rows included), any file's coverage, and every setup line.
  - Check `coverage-lines`: for each source present in both inputs with equal, present `hash`, the head's covered lines must include the base's. `lost` lists the missing lines.
  - Check `coverage-ratio`: covered over coverable, summed over all sources, must not be lower at head than at base. It is compared as exact fractions, and the check reports both ratios as `base` and `head`.
- **G5** **Critical coverage.** The check `critical-coverage` covers every critical source present in both inputs:
  - With `guard.criticalCoverage` `"ratchet"` (default), each critical source's covered-over-coverable at head must not be lower than at base, **and** the same must hold for all those sources together.
  - With a number N, each of them and their aggregate must also be at least N percent at head, compared as exact fractions.
  - A ratio with nothing coverable at base passes; with nothing coverable at head it fails if base covered anything. A floor is met when nothing is coverable.
  - A critical source deleted at head, or a mutant whose id changed, is not compared: code that changed is judged by G4's ratio and by the mutants that still exist.
  - `sources` lists the critical sources that fail, sorted.
- **G6** **Critical mutation never falls.** Check `critical-mutation`:
  - Every mutant on a critical source that is detected at base and present at head (same id) must be detected at head. `lost` lists the mutant ids.
  - If base has any mutant on a critical source and head has no `mutation` data, the check fails with `missing: true`. Absent data is never a pass.
- **G7** **No critical unit removed without approval.** Check `critical-removed`: each unit critical at base and absent at head needs an approval `{ action: "remove", id }`. `units` lists the unapproved ones, sorted.
- **G8** **No critical unit downgraded without approval.** Check `critical-downgraded`: each unit critical at base and present but not critical at head needs an approval `{ action: "downgrade", id }`. `units` lists the unapproved ones, sorted.
- **G9** **Evidence.** `removed` lists every unit present at base and absent at head as `{ id, tier, uniqueLines, uniqueKills }`, with values from base, sorted by id.

Optional fields in checks: `coverage-lines` always has `lost.lines` (`{}` when it passes); `coverage-ratio` has `base` and `head`; `critical-coverage` has `sources`; `critical-mutation` has `lost.mutants`, or `missing: true` and no `lost`; `critical-removed` and `critical-downgraded` have `units`; `head-passes` has none of these.

`guard.checks` lists each of the seven checks exactly once, in the order G3, G4 (`coverage-lines`, then `coverage-ratio`), G5, G6, G7, G8. `guard.pass` is true when every check passes. Guard exits 0 when it passes, and 1 when it does not.

## 11. Label

- **L1** `label` reports, for each unit, `tier`, `tierReason` and `protected`. It exits 1 when any `unknown-tag` diagnostic exists (T2), and 0 otherwise.

## 12. Report

- **R1** **Determinism.**
  - The same command, inputs, config and arguments MUST give byte-identical JSON.
  - Arrays are sorted as this spec says, and `units` by id.
  - Object keys appear in the order the report schema lists them.
  - `generatedAt` appears only when passed as an argument, and never after exit 2 or 3.
  - Report `spec` is always `cupel-spec/1`, whatever minor version the input names.
  - **Sections per command:** `report`, `label`, `plan` and `check` emit `runtime`, `suite`, `units` and `groups` (plus `files` at file granularity), then their own section. `guard` emits `runtime` and `guard`. With two inputs, `runtime` is the head's.
  - Every list whose order this spec does not state (rows, `skipped`, map keys such as `lost.lines`) is sorted by code point.
- **R2** **Ratios.**
  - Coverage is reported as `{ covered, coverable, pct }`.
  - Mutation is reported as `{ detected, undetected, score }`, where undetected is survived plus no-coverage; `error` mutants are excluded.
  - `pct` and `score` are `floor(10000 × part / whole) / 100`, so they never overstate. They are `null` when the whole is 0.
- **R3** **Suite totals.**
  - Counts: `tests` (ids), `units`, `passed`, `failed` and `skipped` (ids).
  - `durationMs`: the sum over units.
  - `coverage`: covered lines over all coverable lines.
  - `criticalCoverage`: the same over critical sources.
  - `mutation` and `criticalMutation`.
  - `advice`: a count per advice value, with every value present.

## 13. Exit codes

- **E1** Exit codes are stable:
  - 0: ok;
  - 1: a guardrail or check failed;
  - 2: usage or invalid input;
  - 3: environment (for example a runtime mismatch, or a collector that could not run).

## 14. Collector obligations (proved by the adapter kit, not by engine cases)

- **K1** **Line rule** (spikes S1, S2):
  - Each UTF-16 code unit of a source is classified as whitespace, comment or code.
  - A line is coverable when it holds a code character.
  - Coverage counts are painted widest range first, so a character takes the count of the innermost range containing it.
  - A coverable line is covered when any of its code characters has a count above 0.
  - Characters inside strings and templates count as code, except whitespace. A hashbang line counts as a comment. Lines split at `\n` only, so line numbers agree with `git diff`.
  - Entries for the same file are united.
- **K2** **Scope.** The default scope is the whole repository minus test directories, dependency and virtual-environment directories, and dot-directories, narrowed by config `scope`.
- **K3** **Boundaries.**
  - Coverage from module loading and file-level `before` and `after` hooks goes to `setup`.
  - `beforeEach`, `afterEach` and the test's own teardown go to the test.
  - Concurrent tests' overlapping coverage is attributed to every one of them and MUST NOT make any line unique to one of them.
- **K4** **Re-check.** A unit is listed in `rechecked` only after it has been run in its own process and that run's coverage replaced the shared-process coverage.
- **K5** **Kills.** A mutant counts as killed only when a test reports a failure. A process crash before any test reports is an environment error, to be re-run.
- **K6** **Mutants in memory.** Mutants are served in memory (for example by a module load hook), never written to disk, so source-text pins earn no kills (spike S3). A unit is listed in `targeted` only when every mutant generated on its own lines was run.
- **K7** **Flakes.** A mutant detected at base that survives at head is re-run at least twice more before it is reported as survived (spike S4).
- **K8** **Durations.** Durations are recorded from at least `advice.minRuns` runs where that is affordable.
- **K9** **Runtime.** `runtime` names the interpreter and its exact version.
- **K10** **Test ids.** Ids are stable across runs: the file path, `::`, then the full test name as written (tier tags included), with ` > ` between suite levels. Tests that come from one definition (a parametrized or looped test) are rows: they have distinct ids and share `unit`, which is the file path, `::@`, and the line of the definition (for example `tests/math.test.mjs::@15`). A test that is the only one from its definition has no `unit`. Adapters list `tests` sorted by id.
  - When two tests in one file have the same full name, the second and later get ` #2`, ` #3` and so on appended to the id.
  - When the definition sits in another module (a helper that registers tests), `unit` is `<file>::@<helper path>:<line>`, with `:<column>` added if two definitions share a line.
  - Only leaf tests appear in `tests`. A parent's own coverage goes to each of its leaves, and a failed parent marks its leaves failed, so advice about a parent never silently covers its children.
- **K11** **Interpreters.** `spawnsInterpreter` is set when a test starts another interpreter of the same language.
- **K12** **Shapes.**
  - The unit's body is every token of the test call after its first argument (the options and the callback). It is tokenised. Strings, numbers and regular expressions are replaced by the placeholders `S`, `N` and `R`.
  - Consecutive 4-token shingles are joined by single spaces.
  - Each shingle is hashed with 32-bit FNV-1a over its UTF-8 bytes, and the shape is the sorted set of distinct hashes.

## 15. Framework adapter contract (D12)

A framework adapter MUST provide four operations, each as a command that writes JSON to standard output:

1. **List:** emit the tests with stable ids (K10), files, names, units and tags.
2. **Select:** run a given set of test ids and nothing else.
3. **Boundaries:** run tests with per-test coverage attributed as K3 requires, and write the input format.
4. **Tags:** map the framework's idiom (a title tag such as `[critical]`, a marker such as `@pytest.mark.cupel_critical`, an annotation or a group) to the tier tags.

An adapter passes when `cupel conformance --adapter <command>` matches every fixture in `conformance/adapters/`.

## 16. Conformance cases

Each case is a directory in `conformance/cases/` holding:
- `case.json`: the command, the rules it proves with their polarity, the arguments and the expected exit code (schema: [`schemas/case.schema.json`](schemas/case.schema.json));
- `input.json`, or `base.json` and `head.json` for guard and for check against a base;
- an optional `config.json`;
- `expected.json`.

**Matching.** An implementation passes a case when:
- its exit code equals `expectExit`;
- its report matches `expected.json` as follows:
  - objects match on the keys `expected.json` lists;
  - arrays match element by element and must have the same length;
  - other values must be equal;
  - the string `"$absent"` as an expected value means the key must not be present.

Cases therefore state exactly the parts of the report they prove. A missing config means the defaults in `config.schema.json`.
