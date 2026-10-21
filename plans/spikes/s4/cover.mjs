#!/usr/bin/env node
// S4 coverage collector: per-test and per-file covered lines for a set of test files, over the whole repository.
//
// Usage:
//   node plans/spikes/s4/cover.mjs --root /abs/suite --out /abs/out-s4 --name before [--rep 1] tests/a.test.mjs tests/b.test.mjs
//
// For each file, two runs:
//  1. Per test: S2's method B (plans/spikes/s2/hook.mjs, `node --test --import hook.mjs <file>`) with
//     CUPEL_S2_SCOPE=repo and raw V8 ranges. Each segment's ranges are turned into lines with S1's line rule
//     (plans/spikes/s1/lines.mjs, scope 'repo': every JS file except tests/**, node_modules and dot-directories).
//  2. Per file, as a cross-check: `node --test <file>` with NODE_V8_COVERAGE (S1's method), same line rule.
// Writes <out>/cover/<name>-r<rep>.json:
//   { files: { file: { tests: { name: [keys] }, setup: [keys], other: [keys], perFile: [keys], spawned: n } } }
// where a key is 'path:line'. `other` holds the 'between' and 'teardown' segments. Standard library only.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timed, args, readNdjson } from '../s2/exec.mjs';
import { linesFromCoverage } from '../s1/lines.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const opt = args(process.argv.slice(2), { rep: '1' });
if (!opt.root || !opt.out || !opt.name || !opt._.length) {
  console.error('usage: node cover.mjs --root <suite> --out <dir> --name <set> [--rep n] <test files>');
  process.exit(2);
}
const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` };
delete env.NODE_V8_COVERAGE;
delete env.NODE_OPTIONS;

const toKeys = (scripts) => {
  const { lines } = linesFromCoverage([{ result: scripts }], opt.root, 'repo');
  const out = [];
  for (const [p, ls] of lines) for (const l of ls) out.push(`${p}:${l}`);
  return out;
};

const result = { name: opt.name, rep: Number(opt.rep), node: process.version, files: {} };
for (const file of opt._) {
  const dir = join(opt.out, 'raw', `${opt.name}-r${opt.rep}`, basename(file));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // 1. method B
  const reporter = [`--test-reporter=${join(HERE, '..', 's2', 'reporter.mjs')}`, `--test-reporter-destination=${join(dir, 'tests.ndjson')}`];
  const b = timed([process.execPath, '--test', ...reporter, '--import', join(HERE, '..', 's2', 'hook.mjs'), file],
    { cwd: opt.root, env: { ...env, CUPEL_S2_OUT: dir, CUPEL_S2_ROOT: opt.root, CUPEL_S2_SCOPE: 'repo' }, log: join(dir, 'log.txt') });
  const results = readNdjson(join(dir, 'tests.ndjson')).filter((x) => x.type !== 'suite');
  const failed = results.filter((x) => x.event === 'fail');
  if (b.code !== 0 || failed.length) throw new Error(`${file}: method B run failed (exit ${b.code}, ${failed.length} failing)`);
  const hookFile = readdirSync(dir).find((f) => f.startsWith('b-') && f.endsWith('.json') && !f.endsWith('.write.json'));
  const hook = JSON.parse(readFileSync(join(dir, hookFile), 'utf8'));
  const tests = {}, setup = new Set(), other = new Set();
  for (const t of hook.tests) tests[t.key] = new Set();
  let shared = 0;
  for (const s of hook.segments) {
    const keys = toKeys(s.scripts);
    if (s.kind === 'test') {
      if (s.shared) shared++;
      for (const o of s.owners) for (const k of keys) tests[o].add(k);
    } else if (s.kind === 'setup') for (const k of keys) setup.add(k);
    else for (const k of keys) other.add(k);
  }
  // 2. per-file NODE_V8_COVERAGE
  const covDir = join(dir, 'v8');
  const p = timed([process.execPath, '--test', file], { cwd: opt.root, env: { ...env, NODE_V8_COVERAGE: covDir }, log: join(dir, 'log-v8.txt') });
  if (p.code !== 0) throw new Error(`${file}: per-file coverage run failed (exit ${p.code})`);
  const docs = readdirSync(covDir).filter((f) => f.startsWith('coverage-')).map((f) => JSON.parse(readFileSync(join(covDir, f), 'utf8')));
  const { lines } = linesFromCoverage(docs, opt.root, 'repo');
  const perFile = [];
  for (const [path, ls] of lines) for (const l of ls) perFile.push(`${path}:${l}`);
  rmSync(covDir, { recursive: true, force: true });
  const spawned = hook.tests.reduce((n, t) => n + t.spawned.length, 0);
  result.files[file] = {
    testsReported: results.length,
    tests: Object.fromEntries(Object.entries(tests).map(([k, v]) => [k, [...v].sort()])),
    setup: [...setup].sort(),
    other: [...other].sort(),
    perFile: perFile.sort(),
    sharedSegments: shared,
    spawned,
    takes: hook.takes,
  };
  console.log(`${opt.name} r${opt.rep} ${basename(file)}: ${results.length} tests, ${hook.tests.length} seen by the hook, ` +
    `setup ${setup.size} lines, per-file ${perFile.length} lines, spawned ${spawned}`);
}
mkdirSync(join(opt.out, 'cover'), { recursive: true });
writeFileSync(join(opt.out, 'cover', `${opt.name}-r${opt.rep}.json`), JSON.stringify(result));
