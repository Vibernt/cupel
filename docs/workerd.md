# Worker code in workerd

**Preview** (spike [S30](../plans/spikes/S30.md), decision D18). When node:test
tests start workerd (through Miniflare, wrangler or the workerd package), Cupel's
node:test collector also measures, per test, which lines of the Worker's own
source files ran inside workerd. Your tests, harness and files stay as they are.

Nothing to configure: collect node:test as usual (`collect-node`, or
`runners.node` in `cupel.json`). When a measured test starts `workerd serve`,
Cupel:

- adds `--inspector-addr=127.0.0.1:<free port>` to that one workerd command and
  talks to it over 127.0.0.1 only (D18: the only connection Cupel ever makes);
- waits until it is attached before workerd reports ready, so no request is missed;
- measures a script only when its text is byte-for-byte a repository file
  (Miniflare's appended `//# sourceURL=` line is allowed). Bundled or transformed
  scripts are left out;
- takes each test's lines at the test's end and just before the harness stops workerd.

**How it measures.** workerd keeps `Profiler.enable` for its own CPU profiler,
so V8's precise coverage cannot run there. Cupel instead sets never-pausing
breakpoints at every location V8 can stop at and rebuilds V8-style block coverage
from the hits. On Cupel's engine this matches V8's own block coverage on 965 of
965 lines in the permanent test and on 1,265 of 1,270 lines in a larger run; see
S30 for the remaining differences. Module top-level code runs when workerd
starts and is counted then, as module loading is in Node.

**Results are never changed by measuring.** Breakpoints slow code, which can
break a test's own time budget. After the measured runs, Cupel runs every test
file that started workerd once more without breakpoints, and takes those tests'
statuses and durations from that plain run; coverage comes from the measured runs.
The collector log says how many tests changed status only while measured, and how
many workerd processes or scripts could not be measured (bundled or transformed
scripts, scripts outside the measured sources).

**Fault testing.** Sources measured in workerd are marked `measuredIn: "workerd"`.
Their mutants are planted in a scratch copy of the project, which the test harness
loads into workerd, one at a time; only the tests that cover the mutated line run,
after an unmutated baseline. The project itself is never written. Tests that read
source text get no credit.

**Cost.** Code with breakpoints runs unoptimised: light tests add about 0.6 s
each, and request-heavy tests can take 10–100 times longer; on one private Workers codebase the 7 measured files took 71 minutes. The plain rerun adds the suite's ordinary time. Collect the full suite
nightly and select changed tests per change.

**Not measured.** Code compiled to WebAssembly (V8 reports no Wasm lines): Cupel records which tests loaded each repository `.wasm` file, `builtInto` in [config](extending/config.md#code-that-another-languages-tests-run) labels the sources built into it, and `crossRunner` can re-test their Rust faults with those tests. Also not measured: module top-level code is counted when the module loads, including any top-level branch that did not run; and
tests that run inside workerd themselves (`@cloudflare/vitest-pool-workers`).
