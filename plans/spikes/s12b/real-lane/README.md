# S12b real Node lane eligibility survey

Date: 2026-10-25. Current verdict: **the explicit opaque-root-`.npmrc` profile
catches both real faults with strict subsets, but its complete selected-head
path is slower than the privacy-guarded full lane in all ten paired runs.**
This is an experimental result, not a PR-mode performance acceptance.

## Required lane

The experiment requires an entire pre-existing Node unit-test lane and its
configured test inventory. A qualifying lane must have at least two test
files, native CJS/ESM JavaScript or the explicitly approved Node 26 erasable
TypeScript loader, Node 22.23.3 or 26.7.0, and source
dependencies limited to Node built-ins, repository-local files and locally
installed, lockfile-pinned pure JavaScript packages whose actual imports and
read bytes are measured. It must not require transforms, child processes,
workers, VM/eval, network, native modules or WASI. Product profiling never
installs packages. The original checkout stays read-only; fixture-only
private temporary output is allowed. A convenient subset of a broader lane
does not qualify.

## Bounded survey

I read only six local `package.json` script/dependency inventories. The one
plausible `node --test` lane was checked for its full configured test-file
inventory and direct forbidden imports/operations. No original test was run.

| Candidate | Existing test lane | Eligibility result |
|---|---|---|
| `/Users/vid/sweetdoc` | `npm test`: 19 core/integration `.test.mjs` files | Ineligible. The full lane directly imports `node:child_process` in core visual-evaluation and integration CLI/git-source tests; preview tests start a local server and use `fetch`. Selecting only core files would change the lane. |
| `/Users/vid/experimets/stableeffect` | `test:js`: `node --test tests/lib.test.mjs` | Ineligible. One test file cannot yield a strict changed-file subset. |
| `/Users/vid/maily/cli` | No test script | Ineligible. TypeScript/esbuild package, no configured Node unit lane. |
| `/Users/vid/channelos` | `test`: Bash/Python smoke runner | Ineligible. No Node unit lane. |
| `/Users/vid/experimets/theater` | `test`: Vitest | Ineligible. TypeScript/Vitest and npm dependencies. |
| `/Users/vid/testvideo/qprep` | No test script | Ineligible. Only HyperFrames check/render scripts. |

The package script and direct-import evidence is available in the original
read-only `package.json` and Sweetdoc test files. I did not read credential
files, clone repositories, install dependencies, or execute original tests.

## One public follow-up

The owner identified the public GitHub repository
[`expressjs/expressjs.com`](https://github.com/expressjs/expressjs.com). I
inspected primary GitHub contents at commit
[`4ca3fa8701629a4eb27c76a69aa6d6e294290b40`](https://github.com/expressjs/expressjs.com/tree/4ca3fa8701629a4eb27c76a69aa6d6e294290b40).
Its [package script](https://github.com/expressjs/expressjs.com/blob/4ca3fa8701629a4eb27c76a69aa6d6e294290b40/package.json)
defines `test:unit` as `node --test tests/unit/*.test.mjs`, with four existing
files. Package runtime metadata requires Node `>=24.15.0`, so Node 22 would
not be a valid project compatibility claim.

The full unit lane was initially **ineligible** for `node-readonly-files-v1`. Its
[`rehype-accessible-tables.test.mjs`](https://github.com/expressjs/expressjs.com/blob/4ca3fa8701629a4eb27c76a69aa6d6e294290b40/tests/unit/rehype-accessible-tables.test.mjs)
imports the repository-local
[`rehype-accessible-tables.mjs`](https://github.com/expressjs/expressjs.com/blob/4ca3fa8701629a4eb27c76a69aa6d6e294290b40/src/plugins/rehype-accessible-tables.mjs),
which directly imports the npm package `unist-util-visit`. The profile was
then expanded to allow locally installed, exactly locked pure JavaScript
dependencies. Dropping this test would still change the established four-file
lane, so it remains included in all eligibility checks.

I cloned a full public working tree into ignored
`.scratch/s12b/real-lane/express` with Git credential helpers and prompts
disabled. Its HEAD is exactly the pinned commit and `git status --short` is
clean. The lockfile records `unist-util-visit` 5.1.0,
`unist-util-is` 6.0.1, `unist-util-visit-parents` 6.0.2 and
`@types/unist` 3.0.3 with SHA-512 integrities. The local npm cache lacked the
exact runtime tarballs. With authorization for public test setup, I fetched
those four exact lockfile URLs, verified SHA-512 before extraction, rejected
links/traversal, and materialized only those package files into the ignored
checkout's `node_modules`. No npm lifecycle/build script ran; package.json,
lockfile, test inventory and tracked source were unchanged. `setup.json` in
ignored scratch records lock, tarball and every installed file hash. The
materializer and fault setup checks pass **5/5** offline tests.

A second initial blocker was its native TypeScript imports:
both localized-link tests import
[`rewrite-localized-links-core.mjs`](https://github.com/expressjs/expressjs.com/blob/4ca3fa8701629a4eb27c76a69aa6d6e294290b40/src/plugins/rewrite-localized-links-core.mjs),
which directly imports `src/config/menu/docs.ts` and
`src/config/versions.ts`. Astra explicitly approved Node 26's native erasable
TypeScript loader, with a distinct profile capability and no alternate
compiler. The unchanged four-file ordinary `node --test` lane now passes
**65/65** on Node 26.7.0 in 129 ms wall (one run; no speed claim). Cupel's
actual Node collector, with that same four-file inventory and one coverage
run, returned **65 exact test IDs**, **75 source files**, per-test coverage for
all 65, and setup entries for all four files. Collector and ordinary runner
IDs/statuses matched exactly.

Two independent scratch worktrees each change one existing source file, no
tests or config. Changing `rehype-accessible-tables.mjs` makes the complete
65-test oracle fail **4** tests; its one-file diagnostic fails **4/13**.
Changing `remark-code-tabs.mjs` makes the complete oracle fail **8** tests;
its one-file diagnostic fails **8/18**. The diagnostics show the intended
faults are observable; strict S12b selection and head-trace validation are
reported below. Raw output,
source hashes and test counts are in ignored `.scratch/s12b/real-lane/`.

After the profile source froze at
`sha256:421c12169fbee2753a48bb3e4635977cf699f764279967e444d6b81d6d994ddc`,
ordinary and constrained full execution saw the same 65 IDs/statuses for the
baseline and both failing heads. No denial, unsupported activity or completion
error appeared. The actual collector's 65 IDs/statuses matched the ordinary
baseline runner. A strict bundle and both source-fault decisions passed
identity checks. Each first-class selected-head trace executed once, ran no
ordinary oracle inside that capture, was accepted by `assessHeadTrace`, and
failed the same 4 or 8 tests as its full oracle.

The selector nevertheless chose **4/4 files for each change**, so neither
real case is a strict subset. In these captures, each file's `reads` and
`probes` paths exactly duplicate its module `imports`. The selector's
conservative rule treats files with application filesystem observations as
affected by any code change. Removing paths merely because they also appear
in `imports` would miss a test that explicitly reads the text of a source it
also imports. Loader-origin and application-origin file observations need
separate provenance before this rule can safely narrow the set.

Those results are **historical evidence from the predecessor profile**. The
new profile distinguishes loader-origin from application-origin filesystem
events and adds a filename-only privacy preflight. At intermediate frozen hash
`sha256:37d37bf7318b5f2d09b1e5029ec691677e4cc9d8d7129542eacc37d309f55fe9`,
its first Express baseline capture refused on checkout-root `.npmrc` before
reading any input contents in that attempt. Git metadata confirms `.npmrc` is
tracked in the pinned public commit; its contents were not opened during this
attempt. The earlier profile had hashed checkout input bytes, including this
file. No result was claimed from the intermediate refused hash. The owner then
approved an explicit `express-root-npmrc-opaque-v1` profile: it excludes only
the root `.npmrc` bytes from input reads/hashes, binds its regular-file
descriptor/presence, and guards test execution against accessing it. The
tracked project file and test inventory remained intact.

The checkout's `LICENSE.md` states Creative Commons
Attribution 4.0; package metadata says `CC-BY-SA-4.0`, a discrepancy not
resolved here. No public source was checked into Cupel.

## Current frozen-profile result

The producer and strict oracle were frozen together at
`sha256:67cb560222d1667eb7628e9b09db586f814167c815e2c21a61e66e5528de230b`.
The run used local macOS arm64, Node 26.7.0, the pinned public commit and the
original four-file, 65-test lane. Git `rev-parse HEAD` and `ls-files --stage --
.npmrc` supplied metadata-only pin/tracking checks; no Git status/diff/index
refresh touched the opaque file. The policy was passed explicitly to baseline,
head and identity calls. The privacy-guarded ordinary full run recorded one
parent and all four test children in its separate complete trace, with zero
denials or errors. The baseline's 65 exact test IDs/statuses matched Cupel's
actual collector and its constrained full execution. Full captures for both
fault heads also matched ordinary/constrained IDs/statuses, with no unsupported
events. Raw sidecars, guards, decisions and timing pairs are in ignored
`.scratch/s12b/real-lane/provenance-final-67cb560222d1/`.

| Existing source fault | Full oracle failures | Strict selected files | Selected failures | Head trace |
|---|---:|---:|---:|---|
| Accessible tables | 4/65 | 2/4 | 4 | Accepted |
| Code tabs | 8/65 | 1/4 | 8 | Accepted |

Each selected-head capture executed only its chosen files, with no ordinary
oracle inside the selected call. Both decisions identified the one intended
changed source. Both had zero denials, unsupported events or false greens.
Baseline profiling cost 669 ms; the two fault full-profile validity captures
cost 658 and 655 ms. Those setup/proof captures are separate from the paired
warm measurements below.

Five alternating pairs per fault compared the complete selected API (decision,
head policy/inventory, one selected capture and trace validation) against an
actual privacy-guarded ordinary full run. The latter includes its privacy-only
preload and complete guard-trace inspection. Both used the same explicit
opaque policy and fixed environment. The order was full/selected,
selected/full, full/selected, selected/full, full/selected.

| Fault | Guarded full wall, ms | Complete selected API wall, ms | Median result |
|---|---:|---:|---|
| Accessible tables | 133, 135, 133, 138, 131 | 417, 409, 414, 410, 424 | 133 vs 414 ms; selected 3.11× slower |
| Code tabs | 133, 131, 130, 129, 132 | 327, 324, 344, 338, 327 | 131 vs 327 ms; selected 2.50× slower |

Selected was faster in **0/5** pairs for each fault. The selected API's
median disadvantage was 281 and 196 ms, respectively. The observed selected
costs comprised decision 79–89 ms, policy/inventory 38–44 ms, constrained
capture 163–250 ms and trace validation 40–45 ms. These are two small source
faults in one public lane; they do not establish universal safety or broader
performance. The current profile passes this bounded real-case safety check
but fails the proposed adoption speed criterion.

## Historical measurement and next action

Public lane prepared: **1**. Actual failing full-oracle cases: **2**. Accepted
selected-head fault catches: **2**, both whole-lane **4/4**. Strict subsets:
**0**. False greens in these two faults: **0**.

Three alternating warm pairs per fault measured native full execution versus
the complete selection API call. The latter includes baseline/head inventory
comparison, policy/hash work, one constrained selected-head capture and head
trace validation. It excludes the separately prepared baseline and does not
hide an ordinary oracle run inside the selected capture.
These measurements use the predecessor hash above; they are not an acceptance
or speed claim for the final privacy and provenance profile.

| Fault | Native full wall, ms | Complete selection API wall, ms | Median comparison |
|---|---:|---:|---:|
| Accessible tables | 122, 126, 125 | 775, 736, 723 | 125 vs 736 ms; API 5.89× slower |
| Code tabs | 128, 125, 123 | 719, 710, 741 | 125 vs 719 ms; API 5.75× slower |

The per-call API time comprised decision 127–166 ms, policy/hash 80–90 ms,
capture 462–476 ms and trace validation 40–45 ms. Separate setup measurements:
the one-run Cupel collector took 251 ms for 65 IDs/75 sources; the frozen
baseline full profile capture took 627 ms. Lockfile dependency preparation was
integrity verified but not separately instrumented for a reliable wall-time
claim. These tiny suites and three pairs do not establish general performance.
Raw historical per-pair order, outcomes, component timing and logs are in ignored
`.scratch/s12b/real-lane/timing-results.jsonl` and adjacent files.

The repeat harness is in `recheck.mjs` and `recheck-utils.mjs`; parser,
exact-row and five-pair alternation checks pass **3/3** targeted tests. The
next best action is to leave selective PR mode experimental while deciding
whether its measured whole-call overhead can be reduced enough to beat the
guarded full lane without weakening the validated privacy and dependency
controls. There is no measured speed benefit to adopt from this real lane.
