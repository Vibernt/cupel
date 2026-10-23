# Cupel benchmark: 10 public repositories

This document is generated from `bench/results/` and existing candidate `.cupel/input.json` files. Missing stage results are shown as pending; mutation counts can appear from a retained input even when its report stage is not recorded.

## Cross-repository summary

| Repository | Size | Agent share | Runner | Baseline median | Cupel collection | Overhead | Critical score | Killed | Timeout | Survived | No coverage | Error | Guard replay | Plan replay | Status |
|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| n8n-mcp | 1072.3 MiB | 63.0% | vitest | — | — | — | — | — | — | — | — | — | — | — | not run |
| browser-tools-mcp | 0.5 MiB | 40.6% | vitest | — | — | — | — | 39 | 0 | 8 | 173 | 0 | — | — | not run |
| apify-mcp-server | 9.5 MiB | 31.5% | vitest | — | — | — | — | 92 | 0 | 6 | 0 | 0 | — | — | not run |
| locally-uncensored | 57.2 MiB | 92.0% | vitest | — | — | — | — | — | — | — | — | — | — | — | not run |
| zotero-mcp | 14.0 MiB | 79.0% | pytest | — | — | — | — | 25 | 0 | 7 | 2 | 0 | — | — | not run |
| Skill_Seekers | 25.9 MiB | 70.5% | pytest | — | — | — | — | 0 | 0 | 0 | 0 | 0 | — | — | not run |
| github-mcp-server | 56.4 MiB | 70.5% | go | — | — | — | — | — | — | — | — | — | — | — | not run |
| zeron | 132.5 MiB | 70.0% | cargo | — | — | — | — | — | — | — | — | — | — | — | not run |
| RazorConsole | 50.7 MiB | 35.0% | dotnet | — | — | — | — | — | — | — | — | — | — | — | not run |
| activeagent | 43.3 MiB | 65.5% | minitest | — | — | — | — | — | — | — | — | — | — | — | not run |

## n8n-mcp

- **Size, language, runner, agent share:** 1072.3 MiB, TypeScript, vitest, 63.0% (200 sampled commits).
- **Baseline:** — median of 0 runs; counts not recorded.
- **Environment failures:** not measured.
- **Cupel:** collection —; two run test-duration sums —; full report —; collection overhead —; peak RSS unavailable.
- **Evidence:** line coverage —, critical line coverage —, critical mutation score —.
- **Critical mutants:** unavailable.
- **Advice:** 0 rewrite pins listed; 0 consolidation groups listed; 0 no-unique-evidence hints.
- **Scope:** CI test.yml uses npm ci --legacy-peer-deps and test:unit. Excludes n8n API, AI validation, other integration, e2e, Docker, UI browser and telemetry paths; these require services, credentials or Chromium.

Top surviving mutants: unavailable.

### Guard replay

Not run.

### Plan replay

Not run.

**Pending or failed:** all stages not run.

## browser-tools-mcp

- **Size, language, runner, agent share:** 0.5 MiB, TypeScript, vitest, 40.6% (138 sampled commits).
- **Baseline:** — median of 0 runs; counts not recorded.
- **Environment failures:** not measured.
- **Cupel:** collection —; two run test-duration sums —; full report —; collection overhead —; peak RSS unavailable.
- **Evidence:** line coverage —, critical line coverage —, critical mutation score —.
- **Critical mutants:** 39 killed; 0 timeout; 8 survived (run but uncaught); 173 no coverage (never run); 0 error.
- **Advice:** 0 rewrite pins listed; 0 consolidation groups listed; 0 no-unique-evidence hints.
- **Scope:** CI uses npm ci. Excludes the integration project because it binds loopback sockets and spawns an MCP server; excludes e2e because it needs Chromium and an extension.

Top surviving mutants on critical code:

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

Not run.

### Plan replay

Not run.

**Pending or failed:** all stages not run.

## apify-mcp-server

- **Size, language, runner, agent share:** 9.5 MiB, TypeScript, vitest, 31.5% (200 sampled commits).
- **Baseline:** — median of 0 runs; counts not recorded.
- **Environment failures:** not measured.
- **Cupel:** collection —; two run test-duration sums —; full report —; collection overhead —; peak RSS unavailable.
- **Evidence:** line coverage —, critical line coverage —, critical mutation score —.
- **Critical mutants:** 92 killed; 0 timeout; 6 survived (run but uncaught); 0 no coverage (never run); 0 error.
- **Advice:** 0 rewrite pins listed; 0 consolidation groups listed; 0 no-unique-evidence hints.
- **Scope:** packageManager is pnpm@11.11.0 and the project test script selects unit. Excludes integration, conformance and evals that require a built server or Apify token.

Top surviving mutants on critical code:

| File | Line | Operator |
|---|---:|---|
| src/tools/actors/delete_actor.ts | 80 | logical |
| src/tools/schedules/delete_schedule.ts | 21 | return-value |
| src/tools/schedules/delete_schedule.ts | 48 | bool-literal |
| src/tools/schedules/delete_schedule.ts | 49 | bool-literal |
| src/tools/schedules/delete_schedule.ts | 50 | bool-literal |
| src/tools/schedules/delete_schedule.ts | 51 | bool-literal |

### Guard replay

Not run.

### Plan replay

Not run.

**Pending or failed:** all stages not run.

## locally-uncensored

- **Size, language, runner, agent share:** 57.2 MiB, TypeScript, vitest, 92.0% (200 sampled commits).
- **Baseline:** — median of 0 runs; counts not recorded.
- **Environment failures:** not measured.
- **Cupel:** collection —; two run test-duration sums —; full report —; collection overhead —; peak RSS unavailable.
- **Evidence:** line coverage —, critical line coverage —, critical mutation score —.
- **Critical mutants:** unavailable.
- **Advice:** 0 rewrite pins listed; 0 consolidation groups listed; 0 no-unique-evidence hints.
- **Scope:** vitest.config.ts includes only src and dev-server tests. Excludes Playwright e2e, Tauri/Rust, voice sidecar and GPU or desktop workloads. Cupel uses the repo vitest.config.ts include list (its own globs have no brace expansion).

Top surviving mutants: unavailable.

### Guard replay

Not run.

### Plan replay

Not run.

**Pending or failed:** all stages not run.

## zotero-mcp

- **Size, language, runner, agent share:** 14.0 MiB, Python, pytest, 79.0% (200 sampled commits).
- **Baseline:** — median of 0 runs; counts not recorded.
- **Environment failures:** tests/test_webdav.py:102 (reported from first run; test name unavailable).
- **Cupel:** collection —; two run test-duration sums —; full report —; collection overhead —; peak RSS unavailable.
- **Evidence:** line coverage —, critical line coverage —, critical mutation score —.
- **Critical mutants:** 25 killed; 0 timeout; 7 survived (run but uncaught); 2 no coverage (never run); 0 error.
- **Advice:** 0 rewrite pins listed; 0 consolidation groups listed; 0 no-unique-evidence hints.
- **Scope:** README uses pytest and release CI ignores test_lifespan.py. Dev extra supplies pytest and optional packages. Excludes live Zotero integration plan and test_lifespan; no Zotero service in container. Node 22 is installed into the cache volume in the Python image; report uses that binary and Cupel Python collector via PYTHONPATH. tiktoken downloads its encoding on first use, so the install step pre-fetches cl100k_base into the cache volume while the network is on.

Top surviving mutants on critical code:

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

Not run.

### Plan replay

Not run.

**Pending or failed:** all stages not run.

## Skill_Seekers

- **Size, language, runner, agent share:** 25.9 MiB, Python, pytest, 70.5% (200 sampled commits).
- **Baseline:** — median of 0 runs; counts not recorded.
- **Environment failures:** not measured.
- **Cupel:** collection —; two run test-duration sums —; full report —; collection overhead —; peak RSS unavailable.
- **Evidence:** line coverage —, critical line coverage —, critical mutation score —.
- **Critical mutants:** 0 killed; 0 timeout; 0 survived (run but uncaught); 0 no coverage (never run); 0 error.
- **Advice:** 0 rewrite pins listed; 0 consolidation groups listed; 0 no-unique-evidence hints.
- **Scope:** Matches the unit lane in .github/workflows/tests.yml and its marker exclusions. Browser, vector DB, MCP-only and service suites are excluded. Node 22 is installed into cache in the Python image; the Cupel Python collector is on PYTHONPATH. Installs requirements.txt and the [ui] extra as separate steps, as its CI does; combined, pip cannot resolve them.

Top surviving mutants: unavailable.

### Guard replay

Not run.

### Plan replay

Not run.

**Pending or failed:** all stages not run.

## github-mcp-server

- **Size, language, runner, agent share:** 56.4 MiB, Go, go, 70.5% (200 sampled commits).
- **Baseline:** — median of 0 runs; counts not recorded.
- **Environment failures:** not measured.
- **Cupel:** collection —; two run test-duration sums —; full report —; collection overhead —; peak RSS unavailable.
- **Evidence:** line coverage —, critical line coverage —, critical mutation score —.
- **Critical mutants:** unavailable.
- **Advice:** 0 rewrite pins listed; 0 consolidation groups listed; 0 no-unique-evidence hints.
- **Scope:** go.mod requires Go 1.27.3; go mod download must cache the selected toolchain as well as modules. CONTRIBUTING.md and CI require ui npm ci/build before script/test, so install caches Node 22 and builds UI. Build-tagged live GitHub e2e with token is excluded. Pending: collector; baseline only.

Top surviving mutants: unavailable.

### Guard replay

Not run.

### Plan replay

Not run.

**Pending or failed:** all stages not run.

## zeron

- **Size, language, runner, agent share:** 132.5 MiB, Rust, cargo, 70.0% (200 sampled commits).
- **Baseline:** — median of 0 runs; counts not recorded.
- **Environment failures:** not measured.
- **Cupel:** collection —; two run test-duration sums —; full report —; collection overhead —; peak RSS unavailable.
- **Evidence:** line coverage —, critical line coverage —, critical mutation score —.
- **Critical mutants:** unavailable.
- **Advice:** 0 rewrite pins listed; 0 consolidation groups listed; 0 no-unique-evidence hints.
- **Scope:** Cargo workspace lockfile and macOS CI include these pure library crates. Excludes native UI, voice/audio, GPU, browser fixtures, iOS and service tests. Pending: collector; baseline only.

Top surviving mutants: unavailable.

### Guard replay

Not run.

### Plan replay

Not run.

**Pending or failed:** all stages not run.

## RazorConsole

- **Size, language, runner, agent share:** 50.7 MiB, C#, dotnet, 35.0% (200 sampled commits).
- **Baseline:** — median of 0 runs; counts not recorded.
- **Environment failures:** not measured.
- **Cupel:** collection —; two run test-duration sums —; full report —; collection overhead —; peak RSS unavailable.
- **Evidence:** line coverage —, critical line coverage —, critical mutation score —.
- **Critical mutants:** unavailable.
- **Advice:** 0 rewrite pins listed; 0 consolidation groups listed; 0 no-unique-evidence hints.
- **Scope:** CI excludes Category=E2E and project targets net8 through net11; sdk:9.0 is run with --framework net9.0. Excludes PTY e2e, UI gallery and other target frameworks. Pending: collector; baseline only.

Top surviving mutants: unavailable.

### Guard replay

Not run.

### Plan replay

Not run.

**Pending or failed:** all stages not run.

## activeagent

- **Size, language, runner, agent share:** 43.3 MiB, Ruby, minitest, 65.5% (200 sampled commits).
- **Baseline:** — median of 0 runs; counts not recorded.
- **Environment failures:** not measured.
- **Cupel:** collection —; two run test-duration sums —; full report —; collection overhead —; peak RSS unavailable.
- **Evidence:** line coverage —, critical line coverage —, critical mutation score —.
- **Critical mutants:** unavailable.
- **Advice:** 0 rewrite pins listed; 0 consolidation groups listed; 0 no-unique-evidence hints.
- **Scope:** Uses the repository's Rake test task with TEST= restricted to root and provider-common tests. Excludes provider integration, evals, docs examples, dashboard, browser sidecar and frontend because they may need services, credentials or generated assets. CI creates and migrates a local Rails SQLite database; install does likewise. Pending: collector; baseline only.

Top surviving mutants: unavailable.

### Guard replay

Not run.

### Plan replay

Not run.

**Pending or failed:** all stages not run.

## Method and caveats

- `install` and the install substeps of guard replay are the sole network-enabled Docker operations. The first install hydrates missing Git blobs from the public remote and verifies the object set. Baselines run three times with `--network none`; report collection uses two runs. Each candidate has a separate Docker cache volume and only its repository and read-only Cupel tree mounted.
- Guard replay selects the five newest non-merge commits that changed tests. Each parent and head is archived inside a container, installed, collected and compared. Plan replay uses the ten newest source-changing non-merge commits with their exact zero-context diff line sets against the report input.
- The plain baseline and Cupel collection may have different instrumentation and file scope; the overhead ratio is collection wall time divided by median plain wall time. Full report wall time includes mutation and is listed separately. Expected plan time is the sum of observed unit durations, not a measured shortened run.
- Mutation is capped at 300 mutants and 1,200 seconds per collection. A score from a capped sample is not whole-code mutation coverage. Cupel can mutate Node and Vitest tests on runtime `node`; Python has no mutation evidence. Missing mutation remains unavailable, not zero.
- Up to fifteen displayed critical survivors are ordered by file and line, not by severity. Critical mutation counts come from each repository’s `.cupel/input.json`; survived means run but uncaught, while no coverage means no test ran the mutant. A no-mutation report with `--runs 2` measures collection plus Cupel grading, so its wall time is an upper bound on collector time. The two run duration sums add each test's duration and are not wall time when tests run in parallel.
- Go, Rust, .NET and Ruby have no Cupel collector in this build. Their baseline is measured but Cupel report and replays remain `pending: collector`. Any install, baseline or collection failure is recorded as a failure without substitute commands.
- Agent share and size come from the candidate inventory, not from these benchmark runs. Agent share measures commit trailers and bot authors in a recent window; it does not prove the authorship of every test.
- Docker, registry access, install scripts, candidate tests, git archive replay and real benchmark timing were not run while building this harness. The orchestrator must run them on Colima linux/arm64 and inspect each stage JSON.

Cleanup after review: remove each candidate’s `.cupel-bench.json`, `.cupel/`, `.cupel-bench-replay-*` and `.cupel-bench-changed-lines.json`; remove `bench/results/<name>/` and named `cupel-bench-<name>-cache` Docker volumes when measurements are no longer needed. `bench/results/.gitkeep` is committed; result JSON stays ignored.

