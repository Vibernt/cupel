# First release: core full guard and bounded native preview

Owner direction: **2026-10-26**. Scope is frozen as JS/TS/Python core full guard,
bounded Go/Ruby/Rust preview, and experimental selective PR outside the
supported first release. The authoritative [support matrix](../docs/support.md)
defines exact versions and limits. The owner authorized public GitHub source
publication for **Vibernt/cupel**, version **0.1.0 / MIT**, on **2026-10-26**.
Registry uploads, publishing tags/releases and social posting remain separate
approval decisions. L1–L7 stay locked; historical spike outcomes are preserved.

## Frozen scope

Core covers the deterministic engine, CLI, local MCP, report/review/check and
ordinary full guard for node:test on Node 22+, Vitest **4.1.11 / 5.0.1**, narrow
Jest **30.2.0** (jest-circus / jest-environment-node **30.2.0**), and pytest on
Python **3.12+**. The current exact Node gates are **22.23.3 / 26.7.0**; installed
Python evidence is **3.14.8 / pytest 9.1.1**. Existing runtime and transform
restrictions apply. [Real-repository ordinary Jest acceptance](results/2026-10-26-jest-acceptance.md)
passed for the historical private 0.0.0 artifact on the complete 51-test / 4-file
jest-junit lane with its original config and documented VM-module dependency
setup. The accepted tarball SHA-256 is
`c17c2e3814015e277c882addeeb0e1416004fe78051b87360f6500594435c15f`.

Go **1.27.1**, MRI **4.0.7 / Minitest 6.0.0**, and closed-grammar macOS
Rust/Cargo **1.97.1** are bounded preview. They have installed fixture evidence;
their real-repository acceptance is unrun. Broader language claims require those
additional gates. Preview is not a claim of general native-language support.

Node **26.7.0** experimental CLI/MCP selective commands remain available.
Their warnings, refusals and scoped results stay visible; Node 22 selective
execution refuses. Selective execution is outside the supported first release,
including unfinished Jest/Vitest/pytest/native profiles. Full guard remains the
whole-suite protection path. No generic CI speedup or hosted required-check
claim is included.

## Candidate gates

The source release is **0.1.0 / MIT**. Its artifact acceptance ran as a
private candidate before public GitHub source authorization. Full Node 26 verify
and Node 22 tests passed **630 Node tests each, zero skips**, plus **45 Python
tests** and **35 Ruby tests / 148 assertions**, with zero skips. Required
Jest/native/package gates ran. The identical npm archive and fresh Python wheel
passed installed metadata, legal, CLI/MCP and runner controls. The stable
installation was switched with its predecessor retained.

See [the candidate record](results/2026-10-26-private-candidate.md) for exact
archive identities, fresh real-project checks and remaining support limits.
Its local handoff is `.scratch/private-candidate/release-0.1.0/handoff.json`;
older handoffs remain immutable historical evidence.

1. **Reviewed commit.** Commit intended source/docs/tests/legal assets with the
   required trailer after inspecting staged paths and diff. No scratch,
   dependency, credential or packaged archive material enters Git.
2. **Public GitHub source launch authorized.** Publish only the reviewed source
   commit to `Vibernt/cupel` and verify repository visibility/licence and the
   documented source installation. The owner's **2026-10-26** approval fulfills
   L6 for GitHub repository visibility; no further source-visibility approval is
   required for that request.
3. **Registry and posting approval remain separate.** npm and PyPI are
   unpublished. Retain npm `private: true` and Python `Private :: Do Not Upload`.
   Registry uploads, publishing tags/releases and posting prepared launch copy
   need separate explicit owner approval.

Hosted Action enforcement/branch protection is unverified and outside this
release claim. If it is later advertised, first run the wrapper as an actual
required check in an authorized private repository with trusted base config,
passing/failing controls and branch enforcement. Local wrapper tests establish
only local behavior.

## Separate feature queue

Selective profile completion, native real-repository promotion, a Rust engine
port, further caching research and generic performance claims are not gates for
this frozen supported scope. Their historical failures and limits remain visible.

The reviewed 0.1.0 implementation and artifact records are committed. Next best
action: verify the authorized public GitHub source and source-install instructions,
then review the prepared launch copy. Registry uploads, publishing tags/releases
and social posting remain separate approval decisions.
