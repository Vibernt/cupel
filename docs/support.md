# First-release support contract

Owner direction: **2026-10-26**. This is the authoritative support matrix for
the first-release scope. It describes supported capabilities and their evidence.
The **0.6.0** source is MIT-licensed; **public GitHub source publication is
authorized** by the owner on **2026-10-26** for `Vibernt/cupel`. npm and PyPI
remain unpublished. Ordinary full guard is the whole-suite protection path.

| Tier | Runner and exact tested boundary | Current evidence and remaining gates |
| --- | --- | --- |
| **Core — JavaScript / TypeScript** | node:test on Node **22.23.3 / 26.7.0**, within the existing source/transform restrictions | Collection, mutation, survivor confirmation and ordinary full guard have source and installed acceptance; Node 22+ is the supported minimum. Other exact runtime combinations are unverified. |
| **Core — JavaScript / TypeScript** | Vitest **4.1.11 / 5.0.1**, within [Vitest limits](vitest.md) | Collection, mutation, survivor confirmation and ordinary full guard are implemented and tested. |
| **Core — JavaScript / TypeScript** | Jest, jest-circus and jest-environment-node **30.2.0**, one project, Node environment, within [Jest limits](jest.md) | Actual-runtime fixtures and installed CLI/MCP acceptance pass. **Real-repository ordinary Jest acceptance passed** on the complete pinned jest-junit lane; see [accepted evidence](../plans/results/2026-10-26-jest-acceptance.md). Native ESM test files and arbitrary third-party transforms remain unsupported. |
| **Core — Python** | Python **3.12+** / pytest; current installed evidence is Python **3.14.8** / pytest **9.1.1**, within [Python limits](python.md) | Collection, mutation, survivor confirmation and ordinary full guard have source and installed acceptance. Other exact runtime combinations are unverified. |
| **Bounded preview — Go** | Go **1.27.1**, offline pure-Go profile, within [Go limits](go.md) | Source and installed fixture acceptance pass. **Real-repository acceptance is unrun**; broader Go support is unverified. |
| **Bounded preview — Ruby** | MRI Ruby **4.0.7** / Minitest **6.0.0**, direct-file loader, within [Ruby limits](ruby.md) | Source and installed fixture acceptance pass. **Real-repository acceptance is unrun**; Rails, Rake and custom mutation loaders are unclaimed. |
| **Bounded preview — Rust** | Coverage on any OS with rustup and matching LLVM tools (evidence: Rust **1.94.1** / LLVM 21 on `aarch64-apple-darwin`); mutation through the user's cargo-mutants (evidence: **27.1.0**); the restricted built-in mutator (`backend: "cupel-rust"`) keeps its Rust/Cargo **1.97.1** closed-grammar profile, within [Rust limits](rust.md) | Source fixture acceptance passes for workspace coverage and cargo-mutants import/run; installed fixture acceptance pass in prior runs for the restricted backend. **Real-repository acceptance is unrun** as a recorded gate: coverage matched plain LLVM line for line on one private 5,828-line workspace. cargo-mutants timeouts are re-run alone and never credit a test; the [timeout concern](rust.md) remains for the restricted backend. Linux and Windows are unverified. |
| **Preview — Worker code in workerd** | node:test tests that start workerd (Miniflare 5 evidence), within [workerd limits](workerd.md) | Per-test coverage rebuilt from breakpoints matches V8 block coverage line for line in the permanent test except one named statement where V8 over-reports two lines and the rebuild is right (1,265 of 1,270 in a larger run); statuses and durations come from a plain rerun; fault testing runs in a scratch copy. One private Workers codebase: 17 of 17 tests unchanged. Real-repository acceptance is unrun as a recorded gate. |
| **Experimental — selective PR** | `node-readonly-files-v2` on Node **26.7.0** only, on Linux and macOS (it refuses on Windows), within [selective PR limits](selective-pr.md) | Experimental CLI/MCP commands remain available, with installed fixtures and the derived 65-test Express lane. **Outside the supported first release**. Node 22 selective execution refuses. Jest, Vitest, pytest and native selective profiles are unsupported or blocked. |

The core contract covers the deterministic engine, CLI, local stdio MCP,
report/review/check/audit and ordinary full guard. A collector's existence does not
promote its runner to core support. `collect-node` is a node:test-only CI test step;
its one-run, shard and subset modes do not extend to Vitest, Jest, pytest or the
native preview runners. Native preview fixture evidence does not
establish acceptance on a real repository. TypeScript support retains each
runner's exact source, loader and transform restrictions; arbitrary JSX/TSX or
transform configurations are not implied.
Under node:test, `.jsx` and `.tsx` run only through a loader the project sets
up (for example `--import tsx`, `@swc-node/register`, `@babel/register`, or
its own `module.register` / `registerHooks` hook in `runners.node.env.NODE_OPTIONS`).
A JSX source is measured when a test loads it and every script the loader made
from it carries an inline source map back to the unchanged file: its coverable
lines come from the project's own `typescript`, and V8's coverage of the
transformed script is mapped back through the map (the line rule of SPEC K1;
see [node:test: loaders and JSX](node.md)). A JSX source no test loads, one
loaded without a usable map, or one the project's TypeScript cannot read is
listed as not measured, with that reason. The same goes for any source a
loader transforms (tsx compiling a `.ts`): mapped through its source map, or
not measured without one. Faults in measured JSX, and every
fault while a loader is in play, are served beneath the loader and carry a run
proof: a fault not shown to run in every process that loaded it is reported as
`error`, never scored ([which setups score](node.md#fault-testing)). On a
Node with the module-hook bugs Cupel probes for (22.16 to 22.22, for example),
fault testing that would run into them stops with an environment error
([Node versions](node.md#node-versions)). A source a runner cannot read is listed as not measured
with its cause. Reports count not-measured sources beside the coverage
percentage, and the audit lists them; they are never counted as uncovered.
TypeScript declaration files (`.d.ts`, `.d.mts`, `.d.cts`) hold no code and
are never sources. When one runner measures a source another cannot, the
combined report uses the measuring runner's lines only when the other runner's
tests never ran it (JSX no node:test test loaded); when the other runner's tests may
run it unseen (a source-map failure, JSX loaded without a usable map, an unreadable file), Cupel refuses
rather than report faults without those tests. A guard whose head cannot
measure a source its base measured warns `source-unmeasured`. The
experimental Node PR profile refuses a `.tsx` it cannot read, naming JSX as
the reason.

Selective results always have `wholeGuardPass: false`; they cannot approve a
whole-suite guard. Historical S12 false greens and later profile failures remain
recorded. Experimental commands and their warnings are retained. No
automatic fallback, reduced inventory or suppressed refusal changes a support
tier. Correct selection can be slower: no generic CI speedup is claimed.

The Action wrapper has local positive and negative acceptance only. **Hosted
required-check enforcement and branch protection remain unverified** and are
outside the first-release support claim. Public GitHub source publication is
authorized. Registry uploads, publishing tags/releases and social posting still
require separate explicit owner approval. npm stays `private: true`; Python
keeps `Private :: Do Not Upload`; npm and PyPI remain unpublished.

[Release checklist](../plans/FIRST-RELEASE-CHECKLIST.md) tracks the remaining
source, artifact and commit-review gates, plus the distinct source and registry
publication decisions. Historical runtime counts and artifact
hashes in [release readiness](../plans/RELEASE-READINESS.md) describe their named
handoffs; they do not certify later source changes.

Narrow Jest real-repository acceptance used the original jest-junit commit
`f33e1f2c5bfb80e300cb5ed5734503d5d17f8ef0`: **51 original tests / 4 files**, all
retained, unchanged one-project Node config with `transform:{}` and its
documented `NODE_OPTIONS=--experimental-vm-modules` dependency setup. Two installed
collection runs matched all canonical rows. All **11 valid, unsampled critical
mutants** on two declared original public API paths were killed, including two
body-replace mutants. Weakening one original assertion kept all 51 tests and
production coverage unchanged but lost one kill: live Git CLI guard changed
from exit 0 to 1, and fresh MCP reports matched both CLI controls exactly.
Two supplemental confirmation iterations confirmed that survivor; separate **51 + 2** source-pin
controls received zero kill credit. This adds a real CJS lane to existing narrow
TypeScript fixtures; it does not broaden the transform or ESM-test boundary.

The historical private **0.0.0** Jest candidate archive SHA-256 is
`c17c2e3814015e277c882addeeb0e1416004fe78051b87360f6500594435c15f`;
producer identity and full costs are in the linked evidence. Its historical handoff
is `.scratch/private-candidate/handoff-scope-ALquxx/handoff.json`. Its gates
passed with **615 Node outcomes on each of Node 26 and Node 22**, **45 Python
tests, no skips**, and **35 Ruby tests / 148 assertions**. The exact archive
passed both runtimes. These results certify that named artifact; they do not
certify a later source version or licence change. Check the current version and
corresponding handoff before using the maintainer's stable local path.

The current source release uses version **0.6.0** of the npm package (`@vibernt/cupel`; 0.1.1 added collect-once CI collection, 0.1.2 makes `check`'s C3 leave out unstable lines, 0.2.0 adds `cupel audit`, Rust coverage on any OS with cargo-mutants, and Worker code in workerd; 0.3.0 makes fault testing faster: reuse of earlier results, Python stops once two units caught a fault, Rust skips lines no test runs, tests only the packages that run the code and honours `maxMutants`; 0.4.0 adds Cupel's own Rust fault runner (`backend: "cupel"`) and fault-test slices for CI; 0.5.0 keeps Rust builds between runs and shares one prepared build between CI slices, tries each fault's most likely catching tests first in every language, and brings Go and Ruby fault testing up to the other runners, with one shared build for Go; 0.5.1 combines the results of runners that test the same sources; 0.6.0 measures JSX and TypeScript that node:test runs through a project loader, mapped through its source maps, fixes faults in `.ts` under a loader being reported caught when they were not, lists sources a runner cannot measure apart in reports instead of dropping them, and leaves TypeScript declaration files out of coverage; from 0.6.0 the hosted CI passes on Linux, macOS and Windows) and the first-party [MIT licence](../LICENSE). The Python collector package `vibernt-cupel` is 0.4.1 (0.1.1 added the `no-assertion` and `tautology` findings; 0.2.0 stops early and reuses results; 0.3.0 plans and runs slices and records each fault's time; 0.4.0 tries each fault's earlier catching tests and its own test files first; 0.4.1 collects and tests faults on Windows).
See [local installation](install.md) and [artifact provenance](private-use.md#artifact-provenance).
The [versioned candidate record](../plans/results/2026-10-26-private-candidate.md)
records fresh 0.1.0 verification and artifact identities. The
[0.6.0 release record](../plans/results/2026-11-27-0.6.0-release.md), the
[0.5.1 release record](../plans/results/2026-11-26-0.5.1-release.md), the
[0.5.0 release record](../plans/results/2026-11-25-0.5.0-release.md), the
[0.4.0 release record](../plans/results/2026-11-23-0.4.0-release.md), the
[0.3.0 release record](../plans/results/2026-11-23-0.3.0-release.md) and the
[0.2.0 record](../plans/results/2026-11-23-0.2.0-candidate.md) list
what each adds, its evidence and what is not verified (Linux and Windows before 0.6.0, a
full cargo-mutants run on a real workspace, `crossRunner` end to end). Registry uploads,
publishing tags/releases and social posting remain separate approval decisions.
Historical candidate records continue to describe their named private artifacts.
