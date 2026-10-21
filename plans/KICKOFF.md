# Kickoff prompt

Open a new Claude Code session with `/Users/vid/cupel` as the working folder and paste the prompt below.

---

```text
You are starting Cupel: an open-source, local-first tool that keeps only the tests worth running. It measures each test's worth (unique coverage, unique mutation kills, redundancy, cost, brittleness), labels tests critical, standard or minor, advises keep, consolidate, rewrite or retire under hard guardrails, and runs tests by priority. It ships as a CLI (`cupel`), a local MCP server (stdio) and a GitHub Action. No UI, no hosted service, no analytics, no telemetry, no model calls.

The working folder is /Users/vid/cupel. Read every file in plans/ first (README, PRODUCT, ARCHITECTURE, SPIKES, ROADMAP, DECISIONS, RESEARCH). They are the source of truth; the locked decisions in plans/DECISIONS.md are not to be reopened.

## Step 1: confirm before anything outward
Ask me (in one message) to confirm:
- D2 licence: Apache-2.0 (recommended), or another.
- That you may create the PRIVATE GitHub repository Vibernt/cupel now. (I am authorising a private repo in this prompt; still confirm the licence first.)

## Step 2: M0 kickoff (after my confirmation)
1. `git init` in /Users/vid/cupel (branch main). Add: LICENSE, README.md (what Cupel is, status "pre-release, private"), AGENTS.md (rules below), CLAUDE.md (starts with @AGENTS.md; code map and commands, kept short), .gitignore, a minimal package layout per plans/ARCHITECTURE.md (spec/, packages/cupel/, packages/cupel-py/, action/, docs/), and a GitHub Actions workflow that runs the repo's own checks and tests.
2. Create the private repo and push: `gh repo create Vibernt/cupel --private --source . --push --description "Keep only the tests worth running. CLI and MCP for people and coding agents."` Confirm visibility is private afterwards (`gh repo view Vibernt/cupel --json visibility`).
3. Tell me the repo URL and that CI is green.

## Step 3: M1 spikes (S1, S2, S3 first)
Follow plans/SPIKES.md. Run against the local Vibernt Assay checkout /Users/vid/cri-ci READ-ONLY: never edit, commit, push or run its deploy scripts; use a scratch copy (git worktree under /Users/vid/cupel/.scratch/ or a cp) when a spike needs to change test files (S4). Notes for that repo: Node 22+, run tests with `export PATH=/opt/homebrew/bin:$PATH`; `npm run -s test:quiet` prints only failures; `node scripts/test-quiet.mjs tests/<file>.test.mjs` for one file; its CLAUDE.md has a code map and a "never read these whole" list. Record each spike in plans/spikes/S<n>.md with method, numbers and a verdict, and update plans/DECISIONS.md (D6 parser, D7 per-test vs per-file coverage) from the results. Then S4 and S6.

## Step 4: M2 spec, then M3 Node build
Write spec/ (tiers, signals, rules, guardrails, report and config JSON Schemas, version cupel-spec/1) with 30+ conformance cases including negative cases, then the JS engine, the node:test collector, mutation (critical modules and changed lines only, with time and mutant caps), and the CLI commands report, check, guard, plan, label with --json and stable exit codes. Cupel's own tests must pass the conformance cases. Run it end to end on the Assay suite (read-only) and report the numbers.

## Rules (put these in AGENTS.md)
- No telemetry, analytics or network calls. The only future network call is an opt-in --assay connector (not in this build).
- No model calls inside Cupel. Deterministic: same inputs, same report; no clock or randomness in the engine unless seeded and passed in.
- Minimal dependencies; each one pinned and justified in plans/DECISIONS.md. Prefer the Node and Python standard libraries.
- Never weaken a guardrail to make a test pass. Every rule in the spec has a conformance case, including negative cases.
- The repo stays PRIVATE. Do not make it public, publish to npm or PyPI, create releases or tags meant for publishing, or post anywhere without my explicit approval in chat.
- Never modify /Users/vid/cri-ci or /Users/vid/codecrystal; read them only. Do not run their deploy, publish or migration scripts.
- Never read, print or commit secrets or credential files.
- Commits end with: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>. PR descriptions end with: 🤖 Generated with [Claude Code](https://claude.com/claude-code)
- Do not use the Fable model for this work unless I ask.

## How to work
- Use parallel agents where work is independent (e.g. S1 and S3), each on its own branch or worktree; review and merge their work yourself.
- Keep tests quiet and targeted while iterating; run the full suite before each commit to main.
- Report to me at each milestone (M0, each spike, M2, M3) with: what was done, the numbers, decisions you made, what needs my decision, and what was not verified.
```
