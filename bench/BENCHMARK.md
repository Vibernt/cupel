# Cupel benchmark: 10 public repositories

Generated from saved `bench/results/` artifacts. Historical timings remain raw measurements. Overhead is shown only after matching runner sets, test IDs, revision, Cupel, configuration and runtime provenance are verified. A test count alone does not prove test identity.

## Cross-repository summary

| Repository | Size | Agent share | Runner | Baseline median | Collection | Full report | Verified overhead | Comparison | Critical score | Killed | Timeout | Survived | No coverage | Error | Guard | Plan |
|---|---:|---:|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---|---|
| n8n-mcp | 1072.3 MiB | 63.0% | vitest | 38.90 s | 153.63 s | 977.46 s | — | unverified | 48.66% | — | — | — | — | — | ok | ok |
| browser-tools-mcp | 0.5 MiB | 40.6% | vitest | 2.42 s | 5.11 s | 51.14 s | — | unverified | 17.72% | — | — | — | — | — | ok | ok |
| apify-mcp-server | 9.5 MiB | 31.5% | vitest | 32.63 s | 93.89 s | 687.22 s | — | unverified | 93.87% | — | — | — | — | — | ok | ok |
| locally-uncensored | 57.2 MiB | 92.0% | vitest | 342.64 s | — | — | — | unavailable | — | — | — | — | — | — | failed | failed |
| zotero-mcp | 14.0 MiB | 79.0% | pytest | 43.87 s | 2730.55 s | 1132.41 s | — | invalid | 19.08% | — | — | — | — | — | ok | ok |
| Skill_Seekers | 25.9 MiB | 70.5% | pytest | 53.78 s | 184.56 s | 182.29 s | — | unverified | empty | — | — | — | — | — | ok | ok |
| github-mcp-server | 56.4 MiB | 70.5% | go | 15.42 s | 7245.06 s | 9638.43 s | — | invalid | empty | — | — | — | — | — | ok | ok |
| zeron | 132.5 MiB | 70.0% | cargo | — | — | — | — | unavailable | — | — | — | — | — | — | failed | failed |
| RazorConsole | 50.7 MiB | 35.0% | dotnet | — | — | — | — | unavailable | — | — | — | — | — | — | not run | not run |
| activeagent | 43.3 MiB | 65.5% | minitest | 186.23 s | — | — | — | unavailable | — | — | — | — | — | — | failed | failed |

## n8n-mcp

- **Size and scope:** 1072.3 MiB; TypeScript; vitest; agent share 63.0% across 200 sampled commits. CI test.yml uses npm ci --legacy-peer-deps and test:unit. Excludes n8n API, AI validation, other integration, e2e, Docker, UI browser and telemetry paths; these require services, credentials or Chromium.
- **Baseline:** 38.90 s median of 3 runs; 7008 passed/0 failed/35 skipped, 7008 passed/0 failed/35 skipped, 7008 passed/0 failed/35 skipped.
- **Collection:** 153.63 s wall; cold/warm test-duration sums 118.25 s / 114.96 s; full report 977.46 s wall. These are separate measurements.
- **Comparison:** unverified; candidateRevision provenance unavailable; cupelRevision provenance unavailable; configHash provenance unavailable; image provenance unavailable; imageId provenance unavailable; runtime provenance unavailable; clean revision provenance unavailable; exact runner set unavailable; baseline test-ID inventory unavailable; collection/full inventory provenance unavailable. No overhead ratio is claimed.
- **Collected inventory:** 7043 tests; exact ID inventory unavailable.
- **Evidence:** line coverage 61.24%; critical line coverage 52.70%; critical mutation score 48.66% (146 detected, 154 undetected).
- **Critical mutant statuses:** unavailable from saved report stage.
- **Environment failures:** none recorded.
- **Advice:** 8 recorded rewrite pins; 20 recorded consolidation groups; 3186 no-unique-evidence hints.

Recorded top surviving mutants (total statuses unavailable):

| File | Line | Operator |
|---|---:|---|
| src/mcp/tool-docs/workflow_management/n8n-delete-workflow.ts | 20 | bool-literal |
| src/mcp/tool-docs/workflow_management/n8n-manage-credentials.ts | 39 | bool-literal |
| src/mcp/tool-docs/workflow_management/n8n-manage-credentials.ts | 50 | bool-literal |
| src/mcp/tool-docs/workflow_management/n8n-manage-credentials.ts | 55 | bool-literal |
| src/mcp/tool-docs/workflow_management/n8n-manage-credentials.ts | 66 | bool-literal |
| src/mcp/tool-docs/workflow_management/n8n-manage-credentials.ts | 71 | bool-literal |
| src/mcp/tool-docs/workflow_management/n8n-manage-credentials.ts | 76 | bool-literal |
| src/services/credential-scanner.ts | 187 | boundary |
| src/services/credential-scanner.ts | 195 | arith |
| src/services/credential-scanner.ts | 200 | logical |

### Guard replay

| Commit | Verdict | Removed units | Lost lines | Critical mutants lost |
|---|---|---:|---:|---:|
| d8ebc29d998b | pass (all checks) | 5 | 0 | 0 |
| 19b09f50efd8 | pass (all checks) | 2 | 0 | 0 |
| 26d79a47fa33 | pass (all checks) | 0 | 0 | 0 |
| 6b5769477608 | FAIL (critical-mutation) | 11 | 0 | 2 |
| 8ef965a36e2f | pass (all checks) | 0 | 0 | 0 |

### Plan replay

| Commit | Selected share | Selected duration estimate | Full plan estimate | Touched tests in critical or affected |
|---|---:|---:|---:|---:|
| d8ebc29d998b | 35.1% | — | 115.41 s | 431/431 |
| 19b09f50efd8 | 20.1% | — | 115.41 s | 107/107 |
| 26d79a47fa33 | 20.1% | — | 115.41 s | 98/98 |
| 6b5769477608 | 22.9% | — | 115.41 s | 194/194 |
| 8ef965a36e2f | 19.4% | — | 115.41 s | 5/5 |
| f64d2a7387be | 16.2% | — | 115.41 s | 0/0 |
| 347cf93fed96 | 17.2% | — | 115.41 s | 12/12 |
| 502b317eb768 | 20.0% | — | 115.41 s | 129/129 |
| 3a2ec761e006 | 19.0% | — | 115.41 s | 206/206 |
| 1284c9fdabe7 | 21.7% | — | 115.41 s | 192/192 |

**Stage status and reasons:**

- install: ok.
- baseline: ok.
- report: ok.
- guard-replay: ok.
- plan-replay: ok.
- all: failed — stopped at report: collection-only report exited 3: cupel: collecting /work cupel: Vitest: skipped scripts/test-http-search.ts: Invalid character. (node:9) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might chang … was created) cupel report: collector failed: vitest 3.2.6 did not report (1): failed to load config from /work/.scratch/cupel-vitest-y2Rv4r/config.mjs (full detail: /work/.scratch/cupel-vitest-y2Rv4r/collector-error.txt) [full reason in stage JSON].

## browser-tools-mcp

- **Size and scope:** 0.5 MiB; TypeScript; vitest; agent share 40.6% across 138 sampled commits. CI uses npm ci. Excludes the integration project because it binds loopback sockets and spawns an MCP server; excludes e2e because it needs Chromium and an extension.
- **Baseline:** 2.42 s median of 3 runs; 264 passed/0 failed/0 skipped, 264 passed/0 failed/0 skipped, 264 passed/0 failed/0 skipped.
- **Collection:** 5.11 s wall; cold/warm test-duration sums 1.36 s / 1.58 s; full report 51.14 s wall. These are separate measurements.
- **Comparison:** unverified; candidateRevision provenance unavailable; cupelRevision provenance unavailable; configHash provenance unavailable; image provenance unavailable; imageId provenance unavailable; runtime provenance unavailable; clean revision provenance unavailable; exact runner set unavailable; baseline test-ID inventory unavailable; collection/full inventory provenance unavailable. No overhead ratio is claimed.
- **Collected inventory:** 264 tests; exact ID inventory unavailable.
- **Evidence:** line coverage 28.12%; critical line coverage 31.13%; critical mutation score 17.72% (39 detected, 181 undetected).
- **Critical mutant statuses:** unavailable from saved report stage.
- **Environment failures:** none recorded.
- **Advice:** 0 recorded rewrite pins; 15 recorded consolidation groups; 98 no-unique-evidence hints.

Recorded top surviving mutants (total statuses unavailable):

| File | Line | Operator |
|---|---:|---|
| browser-tools-mcp/src/util/redact.ts | 79 | arith |
| browser-tools-mcp/src/util/redact.ts | 80 | return-value |
| browser-tools-mcp/src/util/redact.ts | 137 | logical |
| browser-tools-mcp/src/util/redact.ts | 137 | return-value |
| browser-tools-mcp/src/util/redact.ts | 144 | cmp-flip |
| browser-tools-mcp/src/util/redact.ts | 144 | negate-cond |
| browser-tools-mcp/src/util/redact.ts | 171 | return-value |
| browser-tools-mcp/src/util/redact.ts | 191 | return-value |

### Guard replay

| Commit | Verdict | Removed units | Lost lines | Critical mutants lost |
|---|---|---:|---:|---:|
| 8891cf952a14 | FAIL (coverage-ratio) | 0 | 0 | 0 |
| 79c98ced8cff | pass (all checks) | 0 | 0 | 0 |
| ba8a188313c1 | FAIL (coverage-ratio) | 0 | 0 | 0 |
| 62b9f663cdf0 | FAIL (coverage-ratio, critical-coverage) | 0 | 0 | 0 |
| d3af9781fba4 | pass (all checks) | 0 | 0 | 0 |

### Plan replay

| Commit | Selected share | Selected duration estimate | Full plan estimate | Touched tests in critical or affected |
|---|---:|---:|---:|---:|
| 8891cf952a14 | 21.0% | — | 1.53 s | 0/0 |
| 79c98ced8cff | 27.8% | — | 1.53 s | 60/69 |
| ba8a188313c1 | 34.1% | — | 1.53 s | 0/0 |
| 62b9f663cdf0 | 21.0% | — | 1.53 s | 0/0 |
| d3af9781fba4 | 34.1% | — | 1.53 s | 69/69 |
| 8d9847c3cd55 | 34.1% | — | 1.53 s | 73/73 |
| 0302854d7488 | 21.0% | — | 1.53 s | 0/0 |
| 29f041599889 | 24.4% | — | 1.53 s | 4/4 |
| e2837f84ca70 | 21.0% | — | 1.53 s | 0/0 |
| 1bd0077f5c0d | 34.1% | — | 1.53 s | 69/69 |

**Stage status and reasons:**

- install: ok.
- baseline: ok.
- report: ok.
- guard-replay: ok.
- plan-replay: ok.
- all: failed — stopped at report: expected Vitest collector, got node.

## apify-mcp-server

- **Size and scope:** 9.5 MiB; TypeScript; vitest; agent share 31.5% across 200 sampled commits. packageManager is pnpm@11.11.0 and the project test script selects unit. Excludes integration, conformance and evals that require a built server or Apify token.
- **Baseline:** 32.63 s median of 3 runs; 3283 passed/0 failed/1 skipped, 3283 passed/0 failed/1 skipped, 3283 passed/0 failed/1 skipped.
- **Collection:** 93.89 s wall; cold/warm test-duration sums 36.06 s / 41.99 s; full report 687.22 s wall. These are separate measurements.
- **Comparison:** unverified; candidateRevision provenance unavailable; cupelRevision provenance unavailable; configHash provenance unavailable; image provenance unavailable; imageId provenance unavailable; runtime provenance unavailable; clean revision provenance unavailable; exact runner set unavailable; baseline test-ID inventory unavailable; collection/full inventory provenance unavailable. No overhead ratio is claimed.
- **Collected inventory:** 3284 tests; exact ID inventory unavailable.
- **Evidence:** line coverage 77.72%; critical line coverage 88.85%; critical mutation score 93.87% (92 detected, 6 undetected).
- **Critical mutant statuses:** unavailable from saved report stage.
- **Environment failures:** none recorded.
- **Advice:** 1 recorded rewrite pins; 20 recorded consolidation groups; 1401 no-unique-evidence hints.

Recorded top surviving mutants (total statuses unavailable):

| File | Line | Operator |
|---|---:|---|
| src/tools/actors/delete_actor.ts | 80 | logical |
| src/tools/schedules/delete_schedule.ts | 21 | return-value |
| src/tools/schedules/delete_schedule.ts | 48 | bool-literal |
| src/tools/schedules/delete_schedule.ts | 49 | bool-literal |
| src/tools/schedules/delete_schedule.ts | 50 | bool-literal |
| src/tools/schedules/delete_schedule.ts | 51 | bool-literal |

### Guard replay

| Commit | Verdict | Removed units | Lost lines | Critical mutants lost |
|---|---|---:|---:|---:|
| 09fab118b124 | FAIL (coverage-ratio) | 1 | 0 | 0 |
| d1317ab74495 | FAIL (coverage-ratio) | 7 | 0 | 0 |
| 22a9909f582a | pass (all checks) | 0 | 0 | 0 |
| b326acecb714 | pass (all checks) | 0 | 0 | 0 |
| 5e83c47fc635 | pass (all checks) | 5 | 0 | 0 |

### Plan replay

| Commit | Selected share | Selected duration estimate | Full plan estimate | Touched tests in critical or affected |
|---|---:|---:|---:|---:|
| 09fab118b124 | 86.8% | — | 35.84 s | 446/446 |
| d1317ab74495 | 43.4% | — | 35.84 s | 155/155 |
| b326acecb714 | 11.4% | — | 35.84 s | 5/5 |
| 5e83c47fc635 | 31.0% | — | 35.84 s | 407/407 |
| 449984928eb2 | 11.2% | — | 35.84 s | 0/0 |
| 647b9b09ba4d | 11.8% | — | 35.84 s | 11/44 |
| 53dc34dbec69 | 86.8% | — | 35.84 s | 824/824 |
| e94ea8a3cbc2 | 86.8% | — | 35.84 s | 964/964 |
| b06cc116747a | 86.8% | — | 35.84 s | 24/24 |
| fea9a333b36e | 48.3% | — | 35.84 s | 136/136 |

**Stage status and reasons:**

- install: ok.
- baseline: ok.
- report: ok.
- guard-replay: ok.
- plan-replay: ok.
- all: failed — stopped at report: collection-only report exited 3: cupel: collecting /work cupel report: collector failed: cannot strip TypeScript in src/errors.ts: TypeScript parameter property is not supported in strip-only mode (node:7) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the warning was created).

## locally-uncensored

- **Size and scope:** 57.2 MiB; TypeScript; vitest; agent share 92.0% across 200 sampled commits. Vitest keeps the existing unit scope; Playwright, voice sidecar and GPU workloads remain excluded. Cargo collects the Tauri crate under src-tauri. The benchmark builds a Node 22 image with GTK/WebKit libraries during install, and caches rustup, llvm-tools-preview and crates for network-isolated collection. This image and the Tauri suite have not been exercised in Docker here. Install also stages the same sidecar and dist placeholders required by its Linux CI before cargo test. tauri.linux.conf.json names the x86_64 llama resource directory on every host, so install stages that placeholder too.
- **Baseline:** 342.64 s median of 3 runs; 18473 passed/1 failed/133 skipped, 18473 passed/1 failed/133 skipped, 18473 passed/1 failed/133 skipped.
- **Collection:** — wall; cold/warm test-duration sums —; full report — wall. These are separate measurements.
- **Comparison:** unavailable; baseline or report stage did not complete. No overhead ratio is claimed.
- **Collected inventory:** unavailable tests; exact ID inventory unavailable.
- **Evidence:** line coverage —; critical line coverage —; critical mutation score unavailable.
- **Critical mutant statuses:** unavailable from saved report stage.
- **Environment failures:** src/api/__tests__/build-llama-script.test.ts (22 tests \| 1 failed) 363ms, resolves a non-empty host triple 8ms, src/api/__tests__/build-llama-script.test.ts:150:18, src/api/__tests__/build-llama-script.test.ts (22 tests \| 1 failed) 522ms, resolves a non-empty host triple 12ms, src/api/__tests__/build-llama-script.test.ts (22 tests \| 1 failed) 417ms, resolves a non-empty host triple 10ms; repeated on check: src/api/__tests__/build-llama-script.test.ts:150:18.
- **Advice:** 0 recorded rewrite pins; 0 recorded consolidation groups; 0 no-unique-evidence hints.

### Guard replay

failed

### Plan replay

failed

**Stage status and reasons:**

- install: ok.
- baseline: ok.
- report: failed — collection-only report exited 3: cupel: collecting /work (node:8) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the warning was created) cupe … ternal collector: cargo cupel report: collector failed: runner cargo collection failed: external collector failed (exit 134): <--- Last few GCs ---> (full detail: /work/.scratch/cupel-external-lYO8od/collector-error.txt) [full reason in stage JSON].
- guard-replay: failed — report did not complete: collection-only report exited 3: cupel: collecting /work (node:8) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the  … ternal collector: cargo cupel report: collector failed: runner cargo collection failed: external collector failed (exit 134): <--- Last few GCs ---> (full detail: /work/.scratch/cupel-external-lYO8od/collector-error.txt) [full reason in stage JSON].
- plan-replay: failed — report did not complete: collection-only report exited 3: cupel: collecting /work (node:8) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the  … ternal collector: cargo cupel report: collector failed: runner cargo collection failed: external collector failed (exit 134): <--- Last few GCs ---> (full detail: /work/.scratch/cupel-external-lYO8od/collector-error.txt) [full reason in stage JSON].
- all: failed — stopped at report: collection-only report exited 3: cupel: collecting /work cupel report: collector failed: no Vitest test files found.

## zotero-mcp

- **Size and scope:** 14.0 MiB; Python; pytest; agent share 79.0% across 200 sampled commits. README uses pytest and release CI ignores test_lifespan.py. Dev extra supplies pytest and optional packages. Excludes live Zotero integration plan and test_lifespan; no Zotero service in container. Node 24 is installed into the cache volume in the Python image; report uses that binary and Cupel Python collector via PYTHONPATH. tiktoken downloads its encoding on first use, so the install step pre-fetches cl100k_base into the cache volume while the network is on. plugin/package.json runs node:test on TypeScript and requires Node 24; its tests are configured as a second runner. TypeScript source coverage uses the native Node collector. Scope excludes the built plugin bundle (plugin/dist).
- **Baseline:** 43.87 s median of 3 runs; 4130 passed/4 failed/91 skipped, 4130 passed/4 failed/91 skipped, 4130 passed/4 failed/91 skipped.
- **Collection:** 2730.55 s wall; cold/warm test-duration sums 116.76 s / 100.23 s; full report 1132.41 s wall. These are separate measurements.
- **Comparison:** invalid; baseline counts 4225/4225/4225 differ from collection 4474; candidateRevision provenance unavailable; cupelRevision provenance unavailable; configHash provenance unavailable; image provenance unavailable; imageId provenance unavailable; runtime provenance unavailable; clean revision provenance unavailable; exact runner set unavailable; baseline test-ID inventory unavailable; collection/full inventory provenance unavailable. No overhead ratio is claimed.
- **Collected inventory:** 4474 tests; exact ID inventory unavailable.
- **Evidence:** line coverage 61.96%; critical line coverage 34.44%; critical mutation score 19.08% (25 detected, 106 undetected).
- **Critical mutant statuses:** unavailable from saved report stage.
- **Environment failures:** tests/test_pdf_cascade.py::TestTryAttachOaPdf::test_cascade_order, tests/test_user_agent.py::TestEveryWiredClientIdentifiesItselfTheSameWay::test_sends_the_shared_constant[publisher, tests/test_user_agent.py::TestEveryWiredClientIdentifiesItselfTheSameWay::test_does_not_pose_as_a_browser[publisher, tests/test_webdav.py::test_download_attachment_file_falls_back_to_webdav; repeated on check: tests/test_pdf_cascade.py::TestTryAttachOaPdf::test_cascade_order, tests/test_user_agent.py::TestEveryWiredClientIdentifiesItselfTheSameWay::test_sends_the_shared_constant[publisher, tests/test_user_agent.py::TestEveryWiredClientIdentifiesItselfTheSameWay::test_does_not_pose_as_a_browser[publisher, tests/test_webdav.py::test_download_attachment_file_falls_back_to_webdav.
- **Advice:** 12 recorded rewrite pins; 20 recorded consolidation groups; 2084 no-unique-evidence hints.

Recorded top surviving mutants (total statuses unavailable):

| File | Line | Operator |
|---|---:|---|
| src/zotero_mcp/tools/local_auth.py | 68 | remove-call |
| src/zotero_mcp/tools/local_auth.py | 100 | remove-call |
| src/zotero_mcp/tools/local_auth.py | 171 | remove-call |
| src/zotero_mcp/tools/local_auth.py | 172 | negate-cond |
| src/zotero_mcp/tools/local_auth.py | 172 | remove-not |
| src/zotero_mcp/tools/local_auth.py | 175 | remove-call |
| src/zotero_mcp/tools/local_auth.py | 192 | logical |

### Guard replay

| Commit | Verdict | Removed units | Lost lines | Critical mutants lost |
|---|---|---:|---:|---:|
| 526d7a699f1f | FAIL (critical-coverage) | 0 | 0 | 0 |
| 835985729263 | FAIL (head-passes) | 0 | 0 | 0 |
| 6b49c8e98ee0 | pass (all checks) | 0 | 0 | 0 |
| f4082ec9113e | pass (all checks) | 0 | 0 | 0 |
| 8ff8eb19e893 | FAIL (head-passes) | 0 | 0 | 0 |

### Plan replay

| Commit | Selected share | Selected duration estimate | Full plan estimate | Touched tests in critical or affected |
|---|---:|---:|---:|---:|
| 526d7a699f1f | 5.7% | — | 133.80 s | 0/0 |
| 835985729263 | 5.8% | — | 133.80 s | 0/0 |
| 6b49c8e98ee0 | 9.4% | — | 133.80 s | 67/67 |
| f4082ec9113e | 9.9% | — | 133.80 s | 25/25 |
| 8ff8eb19e893 | 9.0% | — | 133.80 s | 103/103 |
| 1f538099d096 | 7.9% | — | 133.80 s | 31/31 |
| 981abc0eeec0 | 5.7% | — | 133.80 s | 0/0 |
| c57840cbc0f5 | 6.3% | — | 133.80 s | 0/0 |
| ca5cc617ea02 | 8.9% | — | 133.80 s | 99/99 |
| 725aef588536 | 8.6% | — | 133.80 s | 8/8 |

**Stage status and reasons:**

- install: ok.
- baseline: ok.
- report: ok.
- guard-replay: ok.
- plan-replay: ok.
- all: failed — stopped at report: expected pytest collector, got python.

## Skill_Seekers

- **Size and scope:** 25.9 MiB; Python; pytest; agent share 70.5% across 200 sampled commits. Matches the unit lane in .github/workflows/tests.yml and its marker exclusions. Browser, vector DB, MCP-only and service suites are excluded. Node 22 is installed into cache in the Python image; the Cupel Python collector is on PYTHONPATH. Installs requirements.txt and the [ui] extra as separate steps, as its CI does; combined, pip cannot resolve them.
- **Baseline:** 53.78 s median of 3 runs; 4192 passed/0 failed/89 skipped, 4192 passed/0 failed/89 skipped, 4192 passed/0 failed/89 skipped.
- **Collection:** 184.56 s wall; cold/warm test-duration sums 51.32 s / 51.02 s; full report 182.29 s wall. These are separate measurements.
- **Comparison:** unverified; candidateRevision provenance unavailable; cupelRevision provenance unavailable; configHash provenance unavailable; image provenance unavailable; imageId provenance unavailable; runtime provenance unavailable; clean revision provenance unavailable; exact runner set unavailable; baseline test-ID inventory unavailable; collection/full inventory provenance unavailable. No overhead ratio is claimed.
- **Collected inventory:** 4281 tests; exact ID inventory unavailable.
- **Evidence:** line coverage 50.10%; critical line coverage —; critical mutation score empty scored sample (0 detected, 0 undetected).
- **Critical mutant statuses:** unavailable from saved report stage.
- **Environment failures:** none recorded.
- **Advice:** 6 recorded rewrite pins; 20 recorded consolidation groups; 2311 no-unique-evidence hints.

### Guard replay

| Commit | Verdict | Removed units | Lost lines | Critical mutants lost |
|---|---|---:|---:|---:|
| 76d59ab4eaee | pass (all checks) | 2 | 0 | 0 |
| c413bc304d6f | pass (all checks) | 0 | 0 | 0 |
| 2bcab0d6a68c | pass (all checks) | 0 | 0 | 0 |
| 8323b8245621 | pass (all checks) | 0 | 0 | 0 |
| 6673fbd9467b | pass (all checks) | 0 | 0 | 0 |

### Plan replay

| Commit | Selected share | Selected duration estimate | Full plan estimate | Touched tests in critical or affected |
|---|---:|---:|---:|---:|
| 598df68c03a2 | 2.1% | — | 61.88 s | 0/0 |
| 50ffc380e755 | 2.1% | — | 61.88 s | 0/0 |
| 76d59ab4eaee | 6.4% | — | 61.88 s | 21/31 |
| c413bc304d6f | 4.1% | — | 61.88 s | 41/43 |
| 2bcab0d6a68c | 4.5% | — | 61.88 s | 73/73 |
| 8323b8245621 | 4.2% | — | 61.88 s | 18/63 |
| 6673fbd9467b | 3.5% | — | 61.88 s | 33/33 |
| 56c8abba26a0 | 3.4% | — | 61.88 s | 30/30 |
| c15bccdb7ad2 | 3.2% | — | 61.88 s | 60/60 |
| f540a5a37cf0 | 2.9% | — | 61.88 s | 33/71 |

**Stage status and reasons:**

- install: ok.
- baseline: ok.
- report: ok.
- guard-replay: ok.
- plan-replay: ok.
- all: failed — stopped at report: expected pytest collector, got python.

## github-mcp-server

- **Size and scope:** 56.4 MiB; Go; go; agent share 70.5% across 200 sampled commits. go.mod requires Go 1.27.3; go mod download must cache the selected toolchain as well as modules. CONTRIBUTING.md and CI require ui npm ci/build before script/test, so install caches Node 26 and builds UI. Build-tagged live GitHub e2e with token is excluded. The install also runs go list -deps -test ./... so every module the packages and their tests import is cached before the offline stages. script/build-ui runs ui/package.json node:test on TypeScript under Node 26; configure that suite as node alongside Go. TypeScript UI source coverage uses the native Node collector. The baseline uses -count=1 so Go's test result cache cannot answer repeated runs (an earlier baseline measured cached 2 s runs after a 228 s first run), and omits CI's -race, which Cupel's collection does not use either.
- **Baseline:** 15.42 s median of 3 runs; 1068 passed/0 failed/0 skipped, 1068 passed/0 failed/0 skipped, 1068 passed/0 failed/0 skipped.
- **Collection:** 7245.06 s wall; cold/warm test-duration sums 23.58 s / 23.00 s; full report 9638.43 s wall. These are separate measurements.
- **Comparison:** invalid; baseline counts 1068/1068/1068 differ from collection 1077; candidateRevision provenance unavailable; cupelRevision provenance unavailable; configHash provenance unavailable; image provenance unavailable; imageId provenance unavailable; runtime provenance unavailable; clean revision provenance unavailable; exact runner set unavailable; baseline test-ID inventory unavailable; collection/full inventory provenance unavailable. No overhead ratio is claimed.
- **Collected inventory:** 1077 tests; exact ID inventory unavailable.
- **Evidence:** line coverage 84.95%; critical line coverage 87.75%; critical mutation score empty scored sample (0 detected, 0 undetected).
- **Critical mutant statuses:** unavailable from saved report stage.
- **Environment failures:** none recorded.
- **Advice:** 1 recorded rewrite pins; 20 recorded consolidation groups; 522 no-unique-evidence hints.

### Guard replay

| Commit | Verdict | Removed units | Lost lines | Critical mutants lost |
|---|---|---:|---:|---:|
| b98d115bbb08 | FAIL (coverage-ratio) | 0 | 0 | 0 |
| e3809fe91c75 | pass (all checks) | 0 | 0 | 0 |
| 796afb74711d | pass (all checks) | 0 | 0 | 0 |
| c59e8c199efb | pass (all checks) | 0 | 0 | 0 |
| eb47a99ddb86 | pass (all checks) | 0 | 0 | 0 |

### Plan replay

| Commit | Selected share | Selected duration estimate | Full plan estimate | Touched tests in critical or affected |
|---|---:|---:|---:|---:|
| b98d115bbb08 | 19.2% | — | 31.90 s | 90/90 |
| e3809fe91c75 | 9.3% | — | 31.90 s | 16/16 |
| 796afb74711d | 7.2% | — | 31.90 s | 34/34 |
| c59e8c199efb | 7.6% | — | 31.90 s | 38/38 |
| eb47a99ddb86 | 15.2% | — | 31.90 s | 8/8 |
| 55edd58d5e11 | 79.4% | — | 31.90 s | 838/838 |
| cb290407e20d | 30.5% | — | 31.90 s | 90/90 |
| 2d5ad6e76b30 | 50.9% | — | 31.90 s | 135/135 |
| da2cbc8d4f15 | 12.7% | — | 31.90 s | 56/56 |
| 867131bc1278 | 12.2% | — | 31.90 s | 10/10 |

**Stage status and reasons:**

- install: ok.
- baseline: ok.
- report: ok.
- guard-replay: ok.
- plan-replay: ok.
- all: ok.

## zeron

- **Size and scope:** 132.5 MiB; Rust; cargo; agent share 70.0% across 200 sampled commits. Cargo workspace lockfile and macOS CI include these pure library crates. The Cargo collector selects packages from the test-file glob. Excludes native UI, voice/audio, GPU, browser fixtures, iOS and service tests. Collector benchmark has not been run.
- **Baseline:** failed after 1 attempt(s); ? passed/? failed/? skipped.
- **Collection:** — wall; cold/warm test-duration sums —; full report — wall. These are separate measurements.
- **Comparison:** unavailable; baseline or report stage did not complete. No overhead ratio is claimed.
- **Collected inventory:** unavailable tests; exact ID inventory unavailable.
- **Evidence:** line coverage —; critical line coverage —; critical mutation score unavailable.
- **Critical mutant statuses:** unavailable from saved report stage.
- **Environment failures:** baseline failed before named test results.
- **Advice:** 0 recorded rewrite pins; 0 recorded consolidation groups; 0 no-unique-evidence hints.

### Guard replay

failed

### Plan replay

failed

**Stage status and reasons:**

- install: ok.
- baseline: failed — test command did not report counts or timed out: info: syncing channel updates for stable-aarch64-unknown-linux-gnu error: could not download file from 'https://static.rust-lang.org/dist/channel-rust-stable.toml.sha256' to '/cache/rustup/tmp/5h4cc6oxb9f9l7ds_file': error downloading file: error sending request for url (https://static.rust-lang.org/dist/channel-rust-stable.toml.sha256): client error (Connect): dns error: failed to lookup address information: Temporary failure in name resolution.
- report: failed — baseline did not complete: test command did not report counts or timed out: info: syncing channel updates for stable-aarch64-unknown-linux-gnu error: could not download file from 'https://static.rust-lang.org/dist/channel-rust-stable.toml.s … ading file: error sending request for url (https://static.rust-lang.org/dist/channel-rust-stable.toml.sha256): client error (Connect): dns error: failed to lookup address information: Temporary failure in name resolution [full reason in stage JSON].
- guard-replay: failed — report did not complete: baseline did not complete: test command did not report counts or timed out: info: syncing channel updates for stable-aarch64-unknown-linux-gnu error: could not download file from 'https://static.rust-lang.org/dist/c … ading file: error sending request for url (https://static.rust-lang.org/dist/channel-rust-stable.toml.sha256): client error (Connect): dns error: failed to lookup address information: Temporary failure in name resolution [full reason in stage JSON].
- plan-replay: failed — report did not complete: baseline did not complete: test command did not report counts or timed out: info: syncing channel updates for stable-aarch64-unknown-linux-gnu error: could not download file from 'https://static.rust-lang.org/dist/c … ading file: error sending request for url (https://static.rust-lang.org/dist/channel-rust-stable.toml.sha256): client error (Connect): dns error: failed to lookup address information: Temporary failure in name resolution [full reason in stage JSON].
- all: not run.

## RazorConsole

- **Size and scope:** 50.7 MiB; C#; dotnet; agent share 35.0% across 200 sampled commits. CI excludes Category=E2E and project targets net8 through net11; sdk:9.0 is run with --framework net9.0. Excludes PTY e2e, UI gallery and other target frameworks. Pending: collector; baseline only.
- **Baseline:** not run; not recorded.
- **Collection:** — wall; cold/warm test-duration sums —; full report — wall. These are separate measurements.
- **Comparison:** unavailable; baseline or report stage missing. No overhead ratio is claimed.
- **Collected inventory:** unavailable tests; exact ID inventory unavailable.
- **Evidence:** line coverage —; critical line coverage —; critical mutation score unavailable.
- **Critical mutant statuses:** unavailable from saved report stage.
- **Environment failures:** not measured.
- **Advice:** 0 recorded rewrite pins; 0 recorded consolidation groups; 0 no-unique-evidence hints.

### Guard replay

Not run.

### Plan replay

Not run.

**Stage status and reasons:**

- install: not run.
- baseline: not run.
- report: not run.
- guard-replay: not run.
- plan-replay: not run.
- all: not run.

## activeagent

- **Size and scope:** 43.3 MiB; Ruby; minitest; agent share 65.5% across 200 sampled commits. Mirrors the CI test lane with gemfiles/rails8.gemfile; Cupel collects the same files bin/test loads (test/** and actionagent/test/**), including the local Rails SQLite database setup, and runs bin/test. The benchmark container has no provider credentials or external services, so network-dependent tests may still fail. Dashboard frontend has a Node 22 npm test CI lane and is configured as node. The browser-sidecar lane needs a browser and sandbox setup, so remains excluded.
- **Baseline:** 186.23 s median of 3 runs; 3815 passed/256 failed/25 skipped, 3815 passed/256 failed/25 skipped, 3815 passed/256 failed/25 skipped.
- **Collection:** — wall; cold/warm test-duration sums —; full report — wall. These are separate measurements.
- **Comparison:** unavailable; baseline or report stage did not complete. No overhead ratio is claimed.
- **Collected inventory:** unavailable tests; exact ID inventory unavailable.
- **Evidence:** line coverage —; critical line coverage —; critical mutation score unavailable.
- **Critical mutant statuses:** unavailable from saved report stage.
- **Environment failures:** 256/256/256 failed per run; names unavailable.
- **Advice:** 0 recorded rewrite pins; 0 recorded consolidation groups; 0 no-unique-evidence hints.

### Guard replay

failed

### Plan replay

failed

**Stage status and reasons:**

- install: ok.
- baseline: ok.
- report: failed — collection-only report exited 3: cupel: collecting /work cupel: external collector: minitest cupel report: collector failed: runner minitest collection failed: external collector failed (exit 3): cupel-ruby: cannot find define_method at /work/actionagent/test/sandbox_manifest_test.rb:258 (full detail: /work/.scratch/cupel-external-WpdHDZ/collector-error.txt).
- guard-replay: failed — report did not complete: collection-only report exited 3: cupel: collecting /work cupel: external collector: minitest cupel report: collector failed: runner minitest collection failed: external collector failed (exit 3): cupel-ruby: cannot find define_method at /work/actionagent/test/sandbox_manifest_test.rb:258 (full detail: /work/.scratch/cupel-external-WpdHDZ/collector-error.txt).
- plan-replay: failed — report did not complete: collection-only report exited 3: cupel: collecting /work cupel: external collector: minitest cupel report: collector failed: runner minitest collection failed: external collector failed (exit 3): cupel-ruby: cannot find define_method at /work/actionagent/test/sandbox_manifest_test.rb:258 (full detail: /work/.scratch/cupel-external-WpdHDZ/collector-error.txt).
- all: failed — stopped at report: collection-only report exited 3: cupel: collecting /work cupel report: collector failed: no test files match tests/**/*.test.mjs in /work.

## Method and limits

- Saved historical baseline and report stages do not contain revision, Cupel, config, runtime or exact test-ID provenance. Their ratios cannot be verified retrospectively. Count mismatches make Go and Zotero comparisons invalid. Raw wall times are retained.
- A report can cover multiple runners while the plain baseline command runs only one. Future measurements record the report runner inventory, but baseline runner IDs or sets must come from actual runner output; a configured runner name is not evidence that it executed.
- Full report time includes mutation; collection time is a separate no-mutation report with two test runs. Cold and warm sums add individual test durations and are not wall time when tests run in parallel.
- Historical plan replays saved full plan estimates but not selected-duration estimates. The selected estimate is unavailable for those outcomes; no speedup follows from selected share.
- Empty mutation evidence and unavailable mutation evidence are distinct. Scores from capped mutation samples do not describe whole-code mutation coverage. Retained candidate input files are not read by this report generator.
- Candidate size and agent share come from the candidate inventory, not these benchmark stages. Failed and missing stages remain visible; full error text is in the saved stage JSON.
- `all.json` records a separate all-stage invocation. Later individual-stage successes do not erase its earlier failure.

