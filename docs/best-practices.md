# Best practices

How to get reliable answers from Cupel without slowing your team down. Cupel
never changes or deletes tests or code; everything here is about how you and your
agents run it and read it.

## 1. Start with an audit, not a cleanup

Run `cupel report` once, then `cupel audit --input .cupel/input.json`. Read the
six sections in order:

1. **Possibly wrong tests** first. A test that fails, is skipped, checks nothing
   or compares a value with itself protects nothing today.
2. **Tests that catch no faults** next. They run code but would not notice it
   breaking. Strengthen their assertions; do not delete them.
3. **Code with unnoticed faults** shows the exact lines where a planted fault
   went unnoticed. Each is a missing assertion somewhere.
4. **Overlap and combining** last. Overlap is evidence, not proof: two tests that
   run the same lines may check different things. Read both before merging.

Every change to tests goes through `cupel guard` (section 4 below).

## 2. Tell Cupel what matters

- **Mark critical code** with `tiers.critical` path patterns (built-in path words
  such as `auth` already count). Critical source files get full fault testing,
  and guard fails when a fault caught there at base is missed at head. Mark single
  tests with `[critical]` in their titles. Keep the list short: security, money,
  data loss, permissions.
- **Narrow the scope** with `scope.include` and `scope.exclude` so generated code,
  vendored code and fixtures are not measured.
- **Keep `cupel.json` outside the change being judged.** The guard reads it from
  the base commit, so a pull request cannot weaken its own rules.

## 3. Run the right amount at the right time

| When | Command | Fault testing |
| --- | --- | --- |
| While editing | `cupel report`, then `cupel audit` | critical files, reusing earlier results |
| Every pull request | `cupel guard --base origin/main` (or `--base-input` with main's saved input) | changed lines only (`"critical": false`), capped by `maxMutants` |
| Nightly or on main | `cupel report --reuse … --out …` | critical files in full |

[Faster fault testing](speed.md) has the settings and CI recipes, including how
to keep results between runs on CI machines that start empty.

## 4. Guard every test change

- Run `cupel guard` on every change that touches tests, by people or agents.
  It fails when coverage drops, when a critical fault that was caught is no
  longer caught, or when a critical test disappears without approval.
- Approvals for removing or downgrading a critical test are a person's decision.
  Cupel never creates them.
- Keep the same runtime at base and head. `--allow-runtime-change` exists for
  toolchain upgrades and reports line checks as not compared; use it only then.
- Collect with at least two runs (`--runs 2`, the default) so timing-dependent
  lines are known and do not fail the guard.

## 5. Working with coding agents

- Give the agent the MCP server (`cupel mcp --root …`) or the CLI, and ask it to
  read `cupel_review` or `cupel_audit` before changing tests.
- Ask for a fresh `cupel_guard` after its change, and read the diff yourself.
- Treat "these tests overlap" as a question for the agent to answer by reading
  assertions, never as permission to delete.

## 6. Mixed-language repositories

- Configure each runner in one `cupel.json`; their evidence is merged into one
  report.
- Name code that another language's tests run with `builtInto` (for example Rust
  compiled to WebAssembly), so it is labelled instead of counted as untested.
- Use `crossRunner` only for the few Rust files where it matters: each fault costs
  a build of the artifact.

## 7. Rust

- Install cargo-mutants yourself; Cupel never downloads it.
- Cache `target/` in CI; mark few files critical; raise `jobs` only with memory
  to spare.
- Read [Rust](rust.md) for what is refused (custom targets and runners) and why.

## 8. Cloudflare Workers

- Per-test coverage inside workerd works for Worker files that workerd runs as
  they are in the repository. Bundled or compiled Worker code is reported as not
  measured, never as uncovered.
- Collection with workerd is slower (breakpoints run unoptimised): use
  changed-line runs on pull requests and full collection nightly.
- Read [workerd](workerd.md) for the limits.

## 9. Reading results honestly

- Coverage says what ran. Caught faults say what was noticed. Neither says an
  expected value is right; that needs a person or a reviewer.
- `sampled: true` means a cap was reached. A guard pass covers what was measured.
- A test with no unique lines or catches is not proven redundant.
- Reused results are copies of answers whose inputs have not changed. Reuse only
  files your own main-branch runs wrote, never one from the change under review.
  If a result looks wrong, run once with `--no-reuse` to rule reuse out.
