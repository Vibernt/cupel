# Engine notes: the second implementation of `cupel-spec/1`

`src/engine/` was written **only from `spec/SPEC.md` and `spec/schemas/`**, without reading `spec/conformance/`. Its job is to bring the spec's ambiguities to the surface. This file lists every point where the text was ambiguous, silent or contradictory, and the reading the engine uses.

The rule when choosing: take the most conservative reading, meaning the one that protects tests or fails the guard.

Two later additions from the reviewer are treated as normative, and the engine follows them:
- Guard: the seven checks appear once each, in the order G3, G4 (`coverage-lines`, then `coverage-ratio`), G5, G6, G7, G8. `coverage-ratio` carries `base` and `head`. `critical-coverage` carries the sorted failing `sources`. `critical-removed` and `critical-downgraded` carry the sorted unapproved `units`.
- Check: one verdict per unit, in ascending id order. Each verdict carries `brittle`. `extend` appears only with `adds-nothing`, and `lost` only with `weakens`.

## Module layout

| File | Contents |
|---|---|
| `index.mjs` | `run(command, inputs, config, args, schemas) -> { report, exit }`, which dispatches the commands, plus E1 |
| `integrity.mjs` | I1 (schemas), I2 (references), I3 (lines) and argument checks |
| `config.mjs` | Defaults read from `config.schema.json`, and the effective word lists (D4) |
| `model.mjs` | Units (3.3), S1 to S6, T1 to T8, coverage counts |
| `advice.mjs` | A1 to A12, A9 groups, the A10 retire pass, and the `files` list (A12) |
| `commands.mjs` | Suite (R3), unit entries, plan (P1 to P3), check (C1 to C4), guard (G3 to G9) |
| `lines.mjs` | Line sets as interval lists (3.1), set algebra, per-source line maps, and the exclusive-lines sweep (S2) |
| `match.mjs` | Tokens, words and globs (section 5) |
| `rational.mjs` | R2 ratios, and exact threshold and fraction comparisons |
| `keyorder.mjs` | R1 key order, taken from the report schema |
| `order.mjs` | Code point string order |
| `schema.mjs` | The existing JSON Schema validator, reused unchanged |

## Ambiguities, gaps and contradictions

Each entry gives the section or rule, the problem, and **the reading the engine uses**.

### Structure of the spec

1. **G2 (section 10).** The guard rules jump from G1 to G3, and no G2 exists. *Treated as numbering only.*
2. **Section intro, E1.** "Every engine rule (prefixes I, T, S, A, P, C, G, L, R)" leaves out E, but E1 is an engine rule too. *E1 is implemented and tested.*
3. **Rule ids that collide with spike ids.** Several citations point at the spikes in `plans/spikes/`, not at the signal rules with the same ids:
   - A8 cites "(S6)" for "covering nothing is not worth nothing";
   - A9 cites "(S6)" for the subset rule;
   - G1 cites "(S2)" for runtime drift;
   - K6 cites "(S3)" and K7 cites "(S4)".

   A reader can take these as the signal rules S2 to S6. *No behaviour depends on this, but the spec should write them as spike references.*
4. **A9 placement.** A9 is listed after A11, but it is a definition that A5 uses, not a step in the advice order. *It is computed before the advice rules run.*

### Validation and diagnostics (I1 to I3, E1)

5. **I1, diagnostic shape and order.** The spec doesn't say whether there is one diagnostic per schema error, nor how diagnostics are ordered. *There is one per error, and `path` is the JSON pointer. All diagnostics are sorted by `code`, then `path`, `test` and `message`, in code point order, and exact duplicates are dropped.*
6. **I1 with two inputs (guard, check against a base).** A JSON pointer can't say which document it points into. *`path` stays a plain pointer, and `message` starts with `base:` or `head:`.*
7. **I1 to I3, staging.** *Schema errors (config, inputs and arguments) stop the run before I2 and I3. I2 and I3 are collected together. Every input is checked.*
8. **Report after exit 2 or 3.** The report schema says only `spec`, `kind`, `command` and `diagnostics` are present, while R1 says `generatedAt` appears whenever it is passed. *The schema wins: `generatedAt` is left out after exit 2 or 3.*
9. **I2, test-file keys.** I2 doesn't check the keys of `coverage.byFile` or `coverage.setup` against the test files. *They are not diagnosed. `byFile` keys with no tests still count as other files in file-level uniqueness, and they are listed in `files`.*
10. **I2, duplicate mutant ids.** Section 3.5 says mutant ids are unique, but I2 doesn't enforce it, and guard (G6) and check (C3) match mutants by id. *Duplicates get a new diagnostic, `duplicate-mutant`, with exit 2.*
11. **I2, argument `tests`.** An entry may be a unit id or a test id, and a string can be both: a test id of one unit and the id of another unit. *It names both units, which gives more verdicts and so fails more easily.*

    An unknown entry is `unknown-test`. It has no `path`, because arguments are not a document: `test` holds the value, and `message` gives its index.
12. **I3, scope of `bad-range`.** The text covers coverage and mutation entries only. *It also applies to `sources[].coverable` and to argument `changed`.*
13. **Bad arguments have no diagnostic codes.** *The engine adds new codes:*
    - `invalid-arguments` for a wrong shape, or an approval that is not `remove` or `downgrade`, or whose `id` or `by` is empty. L5 requires a person, so `by` is required;
    - `missing-argument` for `check` without `tests`, or with an empty list, which would otherwise pass vacuously;
    - `missing-input` when a needed input is absent.

    *All of them exit 2.*
14. **Unknown command.** The report schema's `command` enum can't express an unknown command. *`run` throws a `TypeError`, which is a caller error. `validate`, which is in the schema enum but not in the spec, runs I1 to I3 only and exits 0.*
15. **Report `spec` value.** *Always `cupel-spec/1`, whatever minor version the input names.*

### Report contents (R1 to R3, L1)

16. **Which sections each command emits** is not stated. *The engine emits:*
    - `report`, `label`, `plan` and `check`: `runtime`, `suite`, `units` and `groups`, plus `files` at file granularity only;
    - `plan` and `check` add their own section;
    - `guard`: only `runtime` and `guard`.

    `label` has to emit full unit objects, because the units item schema requires every field, although L1 names only three.
17. **`runtime` with two inputs.** *The head's runtime. They are equal, or guard has already exited 3.*
18. **Unspecified array orders.** *`rows` are sorted by id, plan `skipped` by id, map keys such as `lost.lines` by source path, and `files` by path. All sorting is by code point, not UTF-16 code unit.*
19. **Optional keys in guard checks** (this matters under `$absent` matching):
    - `head-passes` has no `units`;
    - `coverage-lines` always has `lost.lines`, an empty object when it passes;
    - `critical-mutation` has `lost.mutants`, empty when it passes, or `missing: true` with no `lost` when the head has no mutation data;
    - `critical-coverage` has only `sources`, with no `base` or `head` ratios.
20. **C3 `lost`.** *Both `lines` and `mutants` are always present when the verdict is `weakens`, even if one of them is empty.*

### Matching (section 5)

21. **Tokens.** "Letter or digit" and "lowercase-to-uppercase" are not defined for non-ASCII text. *Letters are Unicode `\p{L}` and digits `\p{Nd}`, and the case boundary is `\p{Ll}` followed by `\p{Lu}`. So `HTTPServer` is one token and `v2Api` is one token, and combining marks split tokens.*
22. **A word with no tokens** (such as `-`, which the schema's `minLength: 1` allows) matches vacuously. *It matches everything, so every file and source becomes critical. This is the conservative reading.*
23. **Globs, `**` inside a segment** (such as `src/**.ts` or `a**b`). The text defines `**` only as whole segments. *In critical globs (`tiers.critical`) it matches across `/`. In minor globs (`tiers.minor`) it behaves as `*`. Either way the ambiguous form protects tests.*

    Also: a run of three or more stars counts as `**`; `a/**` matches `a`, since zero segments are allowed; and `[` and `]` are literal characters.
24. **T1 and T2, tag case.** *Tags are matched exactly. `Critical` is an `unknown-tag` (an error, so `label` exits 1), not a critical tag. The unit then gets its tier from the other rules.* This is the literal reading, and the diagnostic is the protection.
25. **T1 overrides path rules.** A `minor` tag beats T3, T4 and T5, so a tag can quietly downgrade a unit that a critical path or word would protect. G8 catches this only between base and head. *Implemented as written. This is a guardrail gap worth reviewing.*
26. **T4, title words.** *They match the row's `name`, not its `id`. The id also holds the file path.*

### Signals and tiers (S1 to S6, T5, T8)

27. **S6, shapes.** *Shape arrays are treated as sets, so duplicate hashes are ignored.*
28. **S4.** *A row without `durationsMs` contributes 0 to `durationMs` and 0 to `runs`.*
29. **A6 and A9, "critical".** *This means tier `critical`, not protected (T8).*

### Advice (A1 to A12)

30. **A1 contradicts S2, S3 and A10.** A1 says a failing test's coverage and kills are not trusted. S2 subtracts the own lines of "every other unit", including failed ones, and A10's joint safety speaks of "remaining units". Read literally, a unit could be retired because a *failing* unit still covers its lines. *The reported signals (`uniqueLines`, `uniqueKills`) follow S2 and S3 literally. The retire pass trusts only passed units:*
    - condition 1 checks that the removed units' own lines are still covered by remaining passed units, or by setup;
    - condition 2 checks that every detected mutant that had a passed killer still has a remaining passed killer (this is how "still" is read);
    - a duplicate-path partner `v` must itself be passed.
31. **A10 condition 1, setup lines.** "Plus all setup lines" is ambiguous once every unit of a test file is retired, because the file and its setup then disappear. *Setup lines count only for test files that keep at least one unit.*
32. **A10 condition 3, joint safety.** Condition 3 is stated only for the candidate. A later acceptance can retire the last `v` that an earlier duplicate-path unit relied on. *Every accepted duplicate-path unit must still have a qualifying `v` after each acceptance. `duplicateOf` is the smallest qualifying `v` that remains after the pass.*
33. **A10, both paths qualify.** *The reasons are `no-unique-lines`, `no-unique-kills` and `duplicate-of`, in that order, and condition 3 is also required.*
34. **A10 and the earlier rules.** The candidate definition overlaps A3 to A8: a candidate may be pinned, in a group, slow-low-value, or have unique kills through the duplicate path. "Accepted candidates get retire" would then contradict those rules, which come first. *Only units that reach A10 enter the retire pass. Others are never treated as removed, and never get `retire-conflict`.*
35. **A3 reasons.** "For each kind" doesn't say which kinds. *There is one reason per kind in `brittle`, which includes kinds found only on deliberate findings of a pinned unit.*
36. **A4.** "All its findings are deliberate" is vacuously true with no findings. *At least one finding is required.*
37. **A9 eligibility.** *"No brittleness finding" includes deliberate findings.*
38. **A12, `own(u)` at file granularity** is undefined, because S1 reads `byTest`. *`own(u)` is `byFile[file]`, plus the rows' `byTest`, minus `setup[file]`. That gives a real `ownLines`, makes T8 protect units of files that touch critical sources, and widens P2's `affected` bucket.*
39. **A12, units that reach A7 or later.** *Non-critical units get `keep` with hint `file-granularity`. Critical units get `keep` with reason `critical` and no `file-granularity` hint. A8 does not apply.* `files` appears only at file granularity, with file-level own and unique lines built the same way as S1 and S2.
40. **Thresholds.** `shapeSimilarity`, `lineJaccard`, `duplicateShape` and `criticalCoverage` N are compared **exactly, as the decimal the user wrote**: the shortest round-trip form of the JSON number, so `0.8` means 8/10. They are never compared as binary doubles, which would make 4/5 ≥ 0.8 false. A shape or Jaccard value with a zero denominator is 0.

### Plan (P1 to P3)

41. **P1 and P2.** *Failed and skipped units are planned like any other.* `skipped` is sorted by id.
42. **P2, "a changed path".** *A test file counts as changed when any `changed` entry names it, whatever its lines.*

### Check (C1 to C4)

43. **3.7 lists `changed` as an argument of check**, but no C rule uses it. *It is checked for shape and otherwise ignored.*
44. **C3 with no mutation data at head.** "Present at head by id" can't hold when the head has no mutation data. *By analogy with G6 (absent data is never a pass), every mutant the unit detected at base counts as lost. A mutant missing by id when data exists is not compared.*
45. **C3, "detected by it".** *The head mutant is detected, and its `killedBy` names a head row of the unit.*
46. **C1 and C2 at file granularity.** `uniqueLines` is `null`. *Only critical units add value; others are `adds-nothing`, with exit 1.*
47. **C2, `extend` candidates.** *Every other unit, including failed and skipped ones.*

### Guard (G1 to G9)

48. **G4, covered lines.** "Every line in any row's coverage plus every setup line" ignores `byFile`. *Covered lines also include `byFile`, at either granularity. Otherwise a file-granularity guard would compare setup lines only and pass trivially. Failed units' lines count, and G3 fails separately.*
49. **G4 and G5, ratios with a whole of 0.**
    - *When the base has no coverable lines, the check passes.*
    - *When the head has no coverable lines, it fails if the base covered anything.*
    - *A floor N with no coverable lines is met vacuously.*
50. **G5, "its covered-over-coverable".** It is unclear whether this is per critical source or aggregated over them. These can disagree, since the aggregate can fall while every source rises (Simpson's paradox). *Both are required: each critical source in both inputs must not fall, and neither may the aggregate. With a number N, each source and the aggregate must be at least N%.*
51. **G5, floor precision.** "At least N percent" is compared on the exact fraction, not on the floored `pct`. With N given to more than two decimals, the two can differ.
52. **G5 and G6, matching by presence and id.** A critical source deleted at head is not compared by G5. A critical mutant whose id changed at head is not compared by G6. *Implemented as written.* These are guardrail gaps; only G4's ratio can notice them.
53. **G7 and G8, approvals.** *An approval matches a **unit** id exactly. A row's test id does not approve its unit. `by` is required (L5).*
54. **G6.** *`lost` is reported only when data is present (see 19).*
