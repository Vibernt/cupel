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
| `JSX not loaded by any test: …` | No test process loaded it: there is no loader, or no test imports it. |
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
measures a JSX source, the combined input uses its lines if no node:test test
loaded the source. If node:test's tests loaded it but Cupel could not map it,
they ran it unseen, and Cupel refuses to combine rather than test faults
without those tests.

Not measured in this release: JSX run in child processes that tests start (a
re-check adds node children's coverage for other sources, but a child's coverage
file holds no script text to map JSX with), and source maps in separate `.map`
files.

## Fault testing

Faults in measured JSX are planted in the text the loader transforms, never on
disk:

- Cupel's mutant hook is put first in `NODE_OPTIONS`, so it registers before the
  project's loader. For JSX it also registers an innermost async hook
  (`module.register`) that hands the mutated text to the project's loader, which
  then transforms it as it would the file. A synchronous loader
  (`registerHooks`) or a CommonJS require hook (`Module._extensions`, as
  `@babel/register` and `@swc-node/register` use) transforms the text the
  synchronous hook serves.
- **Run proof.** The served text has one extra statement, ahead of the module's
  code and after any directive prologue (`'use client'`, `'use strict'`), on the
  first code line, so no line moves. It records the process when the module runs.
  If a process loaded the fault but never ran that statement, the loader did not
  run the served text (its own cache keyed by file time, its own file read, or a
  chain that skipped it), and the fault is reported as `error`: never `killed`,
  `survived` or `no-coverage`.
- Unmutated (baseline) runs go through the same hooks, so a test the hooks
  themselves break fails unmutated, and its failure is never taken for a catch.

The tests check every `killed` and `survived` JSX fault against a full run of
the mutated file, with an async loader, a sync loader, a CommonJS require hook,
and tsx 4.21.

## Node versions

Node 22.23 or later, or Node 26 (tested: 22.23.1 and 26.7.0). Node 22 before
22.23 (seen on 22.16 and 22.22) rejects CommonJS imports while synchronous and
asynchronous module hooks are both registered: Cupel's mutant hooks with tsx or
any `module.register` loader, or with Cupel's own JSX hook. Fault testing then
stops with an environment error naming this, rather than scoring faults. Before
this release, such runs scored surviving faults as killed. Collection is not
affected.
