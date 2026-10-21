#!/usr/bin/env node
// S2 check: does Profiler.takePreciseCoverage reset the counters when precise coverage runs with
// { callCount: true, detailed: true }? Method B's attribution depends on the answer.
//
// Usage:
//   node plans/spikes/s2/check-reset.mjs
// Writes two small modules to the OS temp directory, imports them under an in-process inspector Session
// (Session.connect(): no port), takes coverage several times and prints the ranges each take reports.
// Expected (and seen on Node 26.7): each take holds only the counts since the previous take; functions that did
// not run since then are left out; an async function resumed after a take is reported with function count 0
// and a block count > 0 for the code after the await.

import { Session } from 'node:inspector';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'cupel-s2-reset-'));
writeFileSync(join(dir, 'mod.mjs'), `export function f(x) {
  if (x > 0) {
    return 'pos';
  }
  return 'neg';
}
export function g() { return 1; }
export let release;
export async function slow() {
  await new Promise((r) => { release = r; });
  if (release) {
    return 'after-await';
  }
  return 'never';
}
`);
const session = new Session();
session.connect();
const post = (m, p) => { let out; session.post(m, p, (e, r) => { if (e) throw e; out = r; }); return out; };
post('Profiler.enable');
post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
const m = await import(pathToFileURL(join(dir, 'mod.mjs')).href);
const show = (label) => {
  const { result } = post('Profiler.takePreciseCoverage');
  const mine = result.filter((s) => s.url.endsWith('/mod.mjs'));
  const text = mine.flatMap((s) => s.functions.map((fn) => `${fn.functionName || '(module)'} ${fn.ranges.map((r) => `[${r.startOffset},${r.endOffset})=${r.count}`).join(' ')}`));
  console.log(`${label.padEnd(30)} ${text.length ? text.join(' | ') : '(nothing reported)'}`);
};
show('after import');
m.f(1); m.f(1); m.f(-1);
show('after f(1), f(1), f(-1)');
m.g();
show('after g()');
show('after nothing');
const p = m.slow();
show('after slow() starts');
m.release(); await p;
show('after slow() resumes');
rmSync(dir, { recursive: true, force: true });
