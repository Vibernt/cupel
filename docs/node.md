# node:test: loaders and JSX

Node runs no JSX by itself. Under node:test, `.jsx` and `.tsx` files run only
through a loader the project sets up, for example `--import tsx`,
`--require @swc-node/register`, `--require @babel/register`, or the project's
own `module.register` / `module.registerHooks` hook. Cupel measures JSX that such
a loader runs and plants faults in it. Anything it cannot show is listed apart
or refused; it never guesses lines or scores a fault it could not show ran.

## Setting up the loader

Put the loader in `runners.node.env.NODE_OPTIONS` in `cupel.json`, so collection
and fault testing both run with it:

```json
{ "runners": { "node": { "tests": "tests/**/*.test.mjs", "env": { "NODE_OPTIONS": "--import tsx" } } } }
```

`cupel collect-node -- --import tsx` also works for collection, but those flags
are not passed to fault testing (`cupel mutate`); use `NODE_OPTIONS` when you
test faults too.

## What is measured

A JSX source is **measured** when a test process loads it and every script the
loader made from it carries an **inline** source map (`//# sourceMappingURL=data:…`)
that leads back to the file as it is (when the map embeds the source, that text
must equal the file). Then:

- its coverable lines come from the project's own `typescript` (the same scanner
  Vitest and Jest use for JSX), so `typescript` must be resolvable from the
  project root;
- the collector reads the exact text the loader produced (V8's
  `Debugger.getScriptSource`, in the test process, as soon as the script appears)
  and maps V8's per-test coverage of it back to original lines through the map,
  with the line rule of SPEC K1. Mapping works at the map's segment granularity,
  so a closing brace can be credited to the code that follows it; maps from
  esbuild (tsx) and from TypeScript differ slightly here.

A JSX source is **not measured**, listed with `unmeasured` and one of these
reasons, and counted apart in reports (never as uncovered):

| Reason | When |
| --- | --- |
| `JSX not loaded by any test: …` | No test process loaded it: there is no loader, or no test imports it, and no test starts a node process. |
| `JSX not loaded in any test process Cupel measures, but tests start node processes …` | Not loaded in a test process, but some test starts a node process (K11), which may run it unseen; or a re-check saw a child process run it. |
| `JSX loaded without a usable source map, …: <cause>` | A loaded script had no inline map, a map without this file, embedded text that differs from the file, or text Cupel could not read. |
| `JSX lines come from the project's typescript, which is not resolvable …` | It was loaded, but no `typescript` resolves from the project root. |
| `JSX the project's typescript cannot parse, …: <cause>` | It was loaded, but TypeScript reports a syntax error in it. |
| `transformed by a loader without a usable source map, …: <cause>` | Any other source (`.ts`, `.js`, …) a loader handed V8 as different text with no usable inline map. |

**Shards.** A shard (`collect-node --shard`) measures a JSX source only if its
own tests load it, and finds a source a loader transformed without a map only
if its own tests load it, so shards can disagree. `merge-inputs` accepts that
with the same hash: a shard that loaded it but could not measure it decides
(the source is unmeasured, and other shards' lines for it are dropped), else a
shard that measured it, else it stays "not loaded". Any other difference
between shards still refuses the merge.

**With Vitest or Jest in the same repository** (K14): when another runner
measures a JSX source (or any source), the combined input uses its lines only with the reason
"not loaded by any test". With any other reason node:test's tests may have run
it unseen (loaded without a usable map, or possibly in a child process), and
Cupel refuses to combine rather than test faults without those tests.

Not measured in this release: JSX run in child processes that tests start (a
child's coverage file holds no script text to map it with; a re-check whose
child runs JSX keeps the unit's shared coverage and does not list it as
re-checked), and source maps in separate `.map` files.

**Other sources a loader transforms.** The same holds for every in-scope
`.ts`, `.js` or other source. Once a test process has a loader in play (a
preload, `--loader`, `--experimental-transform-types`, `module.register`,
`registerHooks`, or a changed `Module._extensions` / `Module.prototype._compile`),
the hook reads the text V8 runs for each in-scope script. Text at the file's own
offsets (the file itself, or Node's own type stripping, which blanks types and
keeps every line) is measured as always. Text a loader made (tsx compiling a
`.ts`) is mapped back through its inline source map; without a usable map the
source is listed as not measured, with the reason `transformed by a loader
without a usable source map, …: <cause>`, and its lines are never guessed.
Without a loader nothing is read, so plain projects measure exactly as before
(the node:test adapter fixture still matches its `expected.json`, and
collection takes the same time). Before this release such a file was measured
against its own text, so lines could be wrong.

## Fault testing

Faults are planted in the text the loader transforms, never on disk. Cupel's
mutant hook goes first in `NODE_OPTIONS`, so it registers before loaders the
project sets up with `--import` there or in its test files, and each test
process reports the loaders it sees: `module.register`, `module.registerHooks`,
`--loader` / `--experimental-loader`, a changed `Module._extensions`, or any
`--import` / `--require` preload besides Cupel's.

- **Where the fault is served.** When the project first calls
  `module.register` (an async loader, such as tsx 4.21), Cupel registers an
  innermost async hook just before it, which hands the mutated text to the
  project's loader. Nothing is registered otherwise, so a test process gets no
  hook or warning it would not have had. A synchronous loader registered after
  Cupel's hook (`registerHooks`, tsx 4.23 on Node 26) and a CommonJS handler
  that compiles the text Node read (`Module._extensions`, wrapping
  `module._compile`) transform the text Cupel's synchronous hook serves.
- **Never past a loader.** `--require` preloads run before Cupel's hook, so a
  loader they register (sync or async) sits below it, as do `--loader` hooks.
  Cupel serves a fault there only when the text coming up from below is the
  file's own bytes (the loader passed it through, as Yarn PnP's loader does for
  source files). When a loader below changed the text, serving would skip it, so
  the fault is `error`.
- **Run proof.** Every JSX fault, and every fault while a loader is in play,
  carries one extra statement, ahead of the module's code and after any
  directive prologue (`'use client'`, `'use strict'`), on the first code line,
  so no line moves. It records the process each time the module runs. A fault
  is scored only when, in the run that decides it, it ran (in the test process
  or a node process the test started, K11), every process that loaded it ran it
  (a module imported and also required loads twice and runs once), no CommonJS
  compile of the file lacked the statement, and no process reported that it
  could not serve the fault. Otherwise it is `error`: never `killed`,
  `survived` or `no-coverage`.
- Unmutated (baseline) runs go through the same hooks, so a test the hooks
  themselves break fails unmutated, and its failure is never taken for a catch.

What was run (macOS; Node 26.7.0, 22.23.1 and 22.22.0; each fixture loader is
written in the tests; tsx runs once per `CUPEL_TEST_TSX`, done separately with
tsx 4.21.0 and tsx 4.23.15 on Node 26.7.0):

| Setup | Faults | Evidence |
| --- | --- | --- |
| ESM `import` through an async loader registered with `--import` or from test files (`module.register`) | scored | fixture loader; tsx 4.21.0 |
| ESM `import` through a synchronous loader registered after Cupel's hook (`registerHooks`) | scored | fixture loader; tsx 4.23.15 |
| CommonJS `require` through a `Module._extensions` handler that compiles the text Node read | scored | fixture hook in that style |
| `.ts` faults under an async loader | scored | fixture loader |
| Plain files a `--loader` / `--experimental-loader` hook passes through unchanged | scored | fixture loader |
| A loader a `--require` preload registers, sync or async, that changes the file's text | `error` | fixture loaders |
| CommonJS `require` through a handler that reads the file itself (tsx's CommonJS path: a default CommonJS package with tsx, or `require()` of a `.tsx` in a `"type": "module"` package) | `error` | fixture; tsx 4.21.0 and 4.23.15 |
| A loader that ignores the text it is handed and reads the file itself | `error` | fixture loader |
| `--experimental-loader` hooks that transform code | environment error: such a project's tests fail under node:test's `--test-isolation=none`, which Cupel's fault runs use (older behaviour) | fixture loader |
| `@babel/register` (pirates; its cache is keyed by file time), `@swc-node/register` | untested; a cached or self-read original is caught by the run proof and gives `error` | none |

## Node versions

Cupel probes the running Node once (two small node processes, only when a
loader is in play) for two module-hook bugs, rather than trusting a version
table:

- with sync and async hooks both registered, an ESM `import` of a CommonJS
  package fails (`ERR_INVALID_RETURN_PROPERTY_VALUE`; nodejs/node#59929, fixed
  in 22.22.3, 24.11.1 and 25.1.0, never in 23.x, by Node's changelogs);
- with any sync hook registered, `require()` of an extension only a loader
  handles (such as `.tsx`) fails (`ERR_UNKNOWN_FILE_EXTENSION`; no fix found in
  Node's changelogs; seen on 22.16.0 and 22.22.0, not on 22.23.1 or 26.7.0).

When the running Node has a bug and the tests run into it (an async loader is
registered, or an unmutated run fails with that bug's code), fault testing stops
with an environment error before anything is scored: a test could fail only
under Cupel's hooks and its faults would look unnoticed. A preload that installs
nothing, an unrelated `require.extensions` entry, or a child process started
with `--import` does not stop it. Before this release such runs scored surviving
faults as killed. Collection is not affected. Probed here: both bugs on 22.16.0
and 22.22.0, neither on 22.23.1 and 26.7.0; 23.x, 24.x and 25.x were not run.
