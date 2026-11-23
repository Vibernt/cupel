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

**Cost.** Code with breakpoints runs unoptimised: light tests add about 0.6 s
each, and request-heavy tests can take 10–20 times longer. Collect the full suite
nightly and select changed tests per change.

**Not measured.** Code compiled to WebAssembly (V8 reports no Wasm lines), and
tests that run inside workerd themselves (`@cloudflare/vitest-pool-workers`).
