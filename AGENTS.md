# Agent rules for Cupel

The plans in `plans/` are the source of truth. The locked decisions in `plans/DECISIONS.md` (L1 to L7) are not to be reopened.

## Rules

- **No telemetry, no analytics, no network calls.** The only network call Cupel will ever make is the opt-in `--assay` connector, and it is not part of this build. `scripts/check.mjs` enforces this.
- **No model calls inside Cupel.** It must be deterministic: the same inputs give the same report. The engine may not read the clock or use randomness unless a seed or time is passed in. `scripts/check.mjs` enforces this for `packages/cupel/src/engine/`.
- **Keep dependencies minimal.** Each one must be pinned to an exact version and justified in `plans/DECISIONS.md`. Prefer the Node and Python standard libraries.
- **Never weaken a guardrail to make a test pass.** Every rule in the spec has a conformance case, including negative cases.
- **The repo stays PRIVATE.** Do not make it public, publish to npm or PyPI, create releases or tags meant for publishing, or post anywhere without the owner's explicit approval in chat. Packages stay `"private": true` (npm) and carry `Private :: Do Not Upload` (PyPI) until then.
- **Never modify `/Users/vid/cri-ci` or `/Users/vid/codecrystal`; only read them.** Do not run their deploy, publish or migration scripts. When a spike needs to change their files, use a scratch copy under `.scratch/`, which is git-ignored.
- **Never read, print or commit secrets or credential files.**
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR descriptions end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Do not use the Fable model for this work unless the owner asks.

## How to work

- Keep test runs quiet and targeted while iterating. Run the full suite (`npm run check && npm test && npm run test:py`) before each commit to `main`.
- Record each spike in `plans/spikes/S<n>.md` with its method, numbers and verdict.
- Report at each milestone with what was done, the numbers, the decisions made, what needs the owner's decision, and what was not verified.
