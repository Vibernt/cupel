# Private candidate 0.1.0

Date: 2026-10-26. First-party licence: MIT. Repository and packages remain private;
no publication, tag, release or registry upload is authorized by this record.
The [support matrix](../../docs/support.md) remains authoritative.

## Exact artifacts

| Artifact | SHA-256 |
| --- | --- |
| `vibernt-cupel-0.1.0.tgz` | `ed2361a2c0dc6f0c9faaac317ad8cf480906aacd725febcd0d1cde4461ab14a4` |
| `vibernt_cupel-0.1.0-py3-none-any.whl` | `cf91eeb46dcdbbe1f498ad2ee5292f00b519b3fd8f1ffa994682bb450dbed917` |

npm producer identity:
`sha256:2d28a2fe975236e15e1f297f52f82ddd3ce9d50381debf3bf26c5eaa7b6035cc`.
Node 26 and Node 22 independently packed and tested identical npm archive bytes.
The wheel was built and installed offline with the explicit pinned tools.
MIT, version and private metadata were checked in the actual installed artifacts.

## Verification

- Node 26.7.0: full `npm run verify`, 630 Node tests, zero failures/skips.
- Node 22.23.3: full `npm test`, 630 tests, zero failures/skips.
- Python: 45 tests, zero skips. Ruby: 35 tests, 148 assertions, zero skips.
- Required Jest, Go, Ruby, Rust and package gates executed, including installed
  behavior kills, lost-protection negatives and CLI/MCP checks.
- Stable-install post-switch checks on both Node versions: exact producer pin,
  version, positive/negative guard, MCP version and canonical legal files.
- Documentation: support contracts, local links/anchors and source help checks.

Local evidence: `.scratch/private-candidate/release-0.1.0/handoff.json`, its
`node26-verify.log` and `node22-test.log`, and package smoke workspaces
`.scratch/package-smoke/run-zdVjSX/` and `run-MU6TEW/`.
The stable path is `.scratch/cupel-install/node_modules/.bin/cupel`; its prior
installation is retained in the new handoff's `previous-install/`.
Historical 0.0.0 handoffs, artifacts and acceptance records are preserved.

## Fresh real-project Jest controls

The exact 0.1.0 archive was rerun on public `jest-community/jest-junit` at
`f33e1f2c5bfb80e300cb5ed5734503d5d17f8ef0`, reusing the previously approved
locked dependencies without downloads. Its original 51 tests / 4 files and
configuration were retained, with zero skips. Two collection runs matched
ordinary Jest, and all 11 valid unsampled mutants in the two declared critical
API paths were killed.

Weakening the same historical assertion kept all 51 tests passing and per-test
production coverage unchanged, but lost one mutation kill. Live full guard
changed from exit 0 to exit 1. Fresh MCP reports exactly matched both CLI
controls; two supplemental survivor confirmations were verified. All 36 upstream
tracked files were restored/unchanged, and 203 packaged files matched installed
and source bytes. These controls do not broaden the narrow Jest support profile.

New ignored evidence: `.scratch/jest-candidate-010-PAAxfr/evidence/acceptance.json`,
SHA-256 `45e7317b74ea36c22ded99e21968a98ea8c809428198e7771842fbbe3b63aba4`.
Its 95-file evidence manifest SHA-256 is
`623bb067737a0c81775c171dda66a3d393d4b4568d56227dec5a3bcef9ff1799`.
The earlier [Jest method and source-pin controls](2026-10-26-jest-acceptance.md)
remain separate historical evidence. No timing benefit or memory claim is made.

## Cleanup and support boundaries

Removed one abandoned Vitest collector temporary directory: 1,155 files,
3,006,321,038 logical bytes (about 2.80 GiB). Metadata assertions verified the
deletion and protected directories; the ignored manifest is
`.scratch/cleanup-2026-10-26.json`. Open Cargo profiles, accepted evidence,
dependencies, rollback artifacts and worktrees were preserved.

JS/TS/Python ordinary full guard is core within documented limits. Native
real-repository acceptance and hosted Action enforcement remain unverified.
Selective PR execution stays private experimental, outside the supported first
release; no general CI speedup or test-cleanup savings are claimed. Rust porting
and more optimization research remain deferred.

The reviewed release files are committed with this record. Next best action:
review the private candidate and decide whether to authorize publication.
