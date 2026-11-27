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

**Shards.** A shard (`collect-node --shard`) measures a JSX source only if its
own tests load it, so shards can disagree. `merge-inputs` accepts that for JSX
with the same hash: a shard that loaded it but could not measure it decides
(the source is unmeasured, and other shards' lines for it are dropped), else a
shard that measured it, else it stays "not loaded". Any other difference
between shards still refuses the merge.

**With Vitest or Jest in the same repository** (K14): when another runner
measures a JSX source, the combined input uses its lines only with the reason
"not loaded by any test". With any other reason node:test's tests may have run
it unseen (loaded without a usable map, or possibly in a child process), and
Cupel refuses to combine rather than test faults without those tests.

Not measured in this release: JSX run in child processes that tests start (a
child's coverage file holds no script text to map it with; a re-check whose
child runs JSX keeps the unit's shared coverage and does not list it as
re-checked), and source maps in separate `.map` files.

**Other sources a loader transforms.** A `.ts` or `.js` file a loader such as
tsx compiles is measured as before, against the file's own text, without its
source map: where the loader moves code, its lines can be off. This is older
behaviour, not specific to JSX.

## Fault testing

Faults are planted in the text the loader transforms, never on disk. Cupel's
mutant hook goes first in `NODE_OPTIONS`, so it registers before the project's
loader, and each test process reports the loaders it sees: `module.register`,
`module.registerHooks`, `--loader` / `--experimental-loader`, a changed
`Module._extensions`, or any `--import` / `--require` preload besides Cupel's.

- **Where the fault is served.** When the project first calls
  `module.register` (an async loader, such as tsx 4.21), Cupel registers an
  innermost async hook just before it, which hands the mutated text to the
  project's loader. Nothing is registered otherwise, so a test process gets no
  hook or warning it would not have had. A synchronous loader (`registerHooks`,
  tsx 4.23 on Node 26) and a CommonJS handler that compiles the text Node read
  (`Module._extensions`, wrapping `module._compile`) transform the text Cupel's
  synchronous hook serves.
- **Run proof.** Every JSX fault, and every fault while a loader is in play,
  carries one extra statement, ahead of the module's code and after any
  directive prologue (`'use client'`, `'use strict'`), on the first code line,
  so no line moves. It records the process each time the module runs. A fault
  is scored only when, in the run that decides it, every process ran it as many
  times as it loaded it, the run's own test process ran it, no CommonJS compile
  of the file lacked the statement, and no process reported that the fault
  could not be served beneath its loader. Otherwise it is `error`: never
  `killed`, `survived` or `no-coverage`.
- Unmutated (baseline) runs go through the same hooks, so a test the hooks
  themselves break fails unmutated, and its failure is never taken for a catch.

| Setup | Faults |
| --- | --- |
| ESM `import` through an async loader (`module.register`: tsx 4.21, a project hook) | scored; tested, with tsx 4.21 and a fixture loader |
| ESM `import` through a synchronous loader (`registerHooks`: tsx 4.23 on Node 26, a project hook) | scored; tested, with tsx 4.23.15 and a fixture loader |
| CommonJS `require` through a `Module._extensions` handler that compiles the text Node read (wraps `module._compile`) | scored; tested with a fixture hook in that style |
| `.ts` faults under an async loader | scored; tested with a fixture loader and tsx 4.21 |
| CommonJS `require` through a handler that reads the file itself (tsx's CommonJS path: a default CommonJS package with tsx, or `require()` of a `.tsx` in a `"type": "module"` package) | `error` (the file ran without the fault); tested with tsx 4.21, 4.23.15 and a fixture |
| A loader that ignores the text it is handed and reads the file itself | `error`; tested with a fixture |
| `--loader` / `--experimental-loader` hooks (registered below Cupel's hook, out of its reach) | `error`; tested with a fixture |
| `@babel/register` (its cache is keyed by file time), `@swc-node/register` | untested; a cached or self-read original is caught by the run proof and gives `error` |

## Node versions

Node 22.23 or later, or Node 26 (tested: 22.23.1, 26.7.0; tsx also on 26.7.0).
Node 22 before 22.23 (seen on 22.16 and 22.22) breaks module loading while
Cupel's hooks and a project loader are both registered: CommonJS imports fail
beside async hooks, and `require()` of an extension only a loader knows (such as
`.tsx`) fails beside any synchronous hook. On those versions fault testing stops
with an environment error, before anything is scored, as soon as a baseline run
shows a loader or preload in play. Before this release, such runs scored
surviving faults as killed. Collection is not affected.
