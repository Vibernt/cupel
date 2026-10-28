# First-release support contract

Owner direction: **2026-10-26**. This is the authoritative support matrix for
the first-release scope. It describes supported capabilities and their evidence.
The **0.1.0** source is MIT-licensed; **public GitHub source publication is
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
| **Bounded preview — Rust** | Rust/Cargo **1.97.1**, `aarch64-apple-darwin`, closed grammar and serial ordinary suite, within [Rust limits](rust.md) | Source and installed fixture acceptance pass in prior runs. **Real-repository acceptance is unrun**. A subsequent run exposed a [timeout-classification concern](rust.md); do not rely on the Rust preview guard as a protection gate until resolved. |
| **Experimental — selective PR** | `node-readonly-files-v2` on Node **26.7.0** only, within [selective PR limits](selective-pr.md) | Experimental CLI/MCP commands remain available, with installed fixtures and the derived 65-test Express lane. **Outside the supported first release**. Node 22 selective execution refuses. Jest, Vitest, pytest and native selective profiles are unsupported or blocked. |

The core contract covers the deterministic engine, CLI, local stdio MCP,
report/review/check and ordinary full guard. A collector's existence does not
promote its runner to core support. `collect-node` is a node:test-only CI test step;
its one-run, shard and subset modes do not extend to Vitest, Jest, pytest or the
native preview runners. Native preview fixture evidence does not
establish acceptance on a real repository. TypeScript support retains each
runner's exact source, loader and transform restrictions; arbitrary JSX/TSX or
transform configurations are not implied.

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

The current source release uses version **0.1.0** and the first-party [MIT licence](../LICENSE).
See [local installation](install.md) and [artifact provenance](private-use.md#artifact-provenance).
The [versioned candidate record](../plans/results/2026-10-26-private-candidate.md)
records fresh 0.1.0 verification and artifact identities. The reviewed release
files are committed. Next best action: verify the public GitHub source and
source-install instructions, then review the launch copy. Registry uploads,
publishing tags/releases and social posting remain separate approval decisions.
Historical candidate records continue to describe their named private artifacts.
