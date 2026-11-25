# Know what your tests actually protect

Cupel runs your own tests, records which lines each test runs, then plants small faults
in the code (a `>=` becomes `>`, a `&&` becomes `||`) and records which tests notice. A
fault that no test notices points at a weak spot, even when coverage says 100%. From that
evidence Cupel guards changes, audits the suite, and shows reviewers and agents what each
test is worth. It never changes your tests or code and sends nothing off your machine.

## Start in three steps

1. **Install.** Download the release tarball and install it offline:
   [Install Cupel](../install.md).
2. **Look.** In your project's Git root run `cupel report`, then
   `cupel audit --input .cupel/input.json`: coverage per test, faults caught and
   unnoticed, six questions about the suite.
3. **Guard.** In every pull request run `cupel guard --base main`: it fails when
   coverage or a critical catch is lost, even when every test still passes.
   [Review and protect a change](../private-use.md).

<div class="cards">
  <a class="card" href="best-practices.html"><strong>Best practices</strong><span>What to run when, how to read results, agents, mixed repositories.</span></a>
  <a class="card" href="speed.html"><strong>Faster fault testing</strong><span>What Cupel skips on its own, reuse, slices and CI recipes.</span></a>
  <a class="card" href="cli.html"><strong>CLI reference</strong><span>Every command, option and exit code.</span></a>
  <a class="card" href="extending/config.html"><strong>Configuration</strong><span>Critical code, runners and settings in cupel.json.</span></a>
  <a class="card" href="mcp.html"><strong>Coding agents</strong><span>The local MCP server for Claude Code, Cursor and Codex.</span></a>
  <a class="card" href="support.html"><strong>Support contract</strong><span>Tested versions, scope and what is not verified.</span></a>
</div>

## Languages

| Language | Support | Guide |
| --- | --- | --- |
| JavaScript and TypeScript (node:test, Vitest, Jest) | Core | [Vitest](../vitest.md), [Jest](../jest.md), [CLI](../cli.md) |
| Python (pytest) | Core | [Python](../python.md) |
| Rust (Cargo) | Preview | [Rust](../rust.md) |
| Go | Preview | [Go](../go.md) |
| Ruby (Minitest) | Preview | [Ruby](../ruby.md) |
| Worker code in workerd | Preview | [workerd](../workerd.md) |

*Core* runs the full guard with installed acceptance; a *preview* is bounded to the
documented profile. Verified on macOS; Linux and Windows are not yet verified.

## Why it is fast enough

A fault runs only the tests that run its line, the tests that caught it last time go
first, it stops after two catches (one in a pull-request guard), unchanged answers are
reused, and Rust and Go compile many faults into one build. On a private Rust workspace a
pull-request guard went from 27 to 21 minutes in 0.5.0 and an unchanged project's setup
from about 9 minutes to 5 seconds; on a second Rust workspace Cupel took 42 s cold and
26 s warm where cargo-mutants took 138 s, with identical results.
[Faster fault testing](../speed.md) explains each step.

## Honest limits

Coverage says what ran and caught faults say what was noticed; neither proves an expected
value is right. A test with no unique catches is not proven redundant, and Cupel never
advises deleting a test. Source, issues and releases are on
[GitHub](https://github.com/Vibernt/cupel); the code is MIT-licensed.
