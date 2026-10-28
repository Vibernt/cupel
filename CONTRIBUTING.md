# Contributing to Cupel

Read [AGENTS.md](AGENTS.md), the locked decisions in
[plans/DECISIONS.md](plans/DECISIONS.md), and the normative [spec](spec/SPEC.md)
first. The [support matrix](docs/support.md) is the first-release contract.
Keep implementations in small modules, with related code organized in folders.
Add or update tests for every change; each spec rule needs positive and negative
conformance coverage. Never weaken a guardrail to make a test pass.

Cupel's pure engine must remain deterministic, free of I/O and runtime APIs.
Shipped Cupel code makes no network or model calls and collects no telemetry.
Project tests, external collectors and configured preparation execute local
code; test fixtures must account for their effects. Pin every dependency to an
exact version and justify it in `plans/DECISIONS.md`.

## Work and verify

Node **22+** is required. The JavaScript source runs without a build or an npm
dependency install. Use targeted tests while editing, for example:

```sh
node --test packages/cupel/test/release-support.test.mjs
npm run -s check
```

Before committing to `main`, run all repository checks and tests:

```sh
npm run verify
```

For work that spawns Node or uses newer Node APIs, also run Node tests on Node 22
before merging. On the maintainer's Homebrew setup:

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm test
```

Use your installed Node 22 path on another host. Enable the local pre-push hook
once per clone with `git config core.hooksPath .githooks`. There is no hosted CI.
The [development guide](docs/development.md) explains required Python/Ruby tools,
fixture-dependent skips and the stricter installed-artifact gates. A green test
command with skipped integrations does not establish runner acceptance.

For an extension, start with [the extension kit](docs/extending/README.md).
Validate a real input, run adapter conformance, and test exact selection, hook
boundaries, errors and the real runner. Extensions use external commands or data;
Cupel does not load third-party extension code into its process.

## Review and publication

Report what changed, test counts and failures, decisions made, any owner decision
needed, and what remains unverified. Record spike methods, numbers and verdicts
in `plans/spikes/S<n>.md`. Inspect the exact staged files before committing;
keep secrets, scratch output and unrelated personal material out of Git.
Do not modify `/Users/vid/cri-ci` or `/Users/vid/codecrystal`; those repositories
are read-only references. Use an ignored `.scratch/` copy for experiments.

The owner authorized public GitHub source publication for `Vibernt/cupel` on
**2026-10-26**, under [MIT](LICENSE). Source version is **0.1.1** (npm package; the Python collector stays 0.1.0); npm and PyPI
remain unpublished. Keep npm `private: true` and Python `Private :: Do Not Upload`.
Registry uploads, publishing releases/tags and social posting still require
separate explicit owner approval. Preserve the [NOTICE](NOTICE) and applicable
third-party licences. See the recorded authorization in [AGENTS.md](AGENTS.md).
Commit messages and PR descriptions must use the trailers specified in
[AGENTS.md](AGENTS.md).
