#!/usr/bin/env node
// S4: compare the coverage of two sets of test files (before and after a consolidation), over repeated runs.
//
// Usage:
//   node plans/spikes/s4/compare.mjs --root /abs/suite --out /abs/out-s4 --before before-r1,before-r2,before-r3 \
//     --after after-r1,after-r2,after-r3 [--before-root /abs/untouched-suite] [--rest /abs/out-s1/lines-cov-repo --area ui-pipelines,ui-pipelines-v2,...]
//
// Reads <out>/cover/<name>.json (written by cover.mjs), one per repeat. For each side:
//   - "ever": lines covered in any repeat, by either method (method B segments, per-file NODE_V8_COVERAGE);
//   - "always": lines covered in every repeat (by either method within that repeat);
//   - "flaky": ever minus always (timing-dependent lines: event streams, aborted navigations);
//   - per test: the lines it covers in every repeat; a test's unique lines are those no other test of the side covers
//     (in any repeat) and no file's module load covers; zero-unique tests have none;
//   - with --rest (S1's per-file line sets of the whole suite at the same commit, minus the files named in --area):
//     the lines only this side covers in the whole suite.
// Guardrail: after.ever must contain before.ever. Lost lines are listed, split into stable (in every before repeat)
// and flaky. Writes <out>/compare-<before0>-<after0>.json, prints a Markdown table; exit 1 when a line is lost.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { args } from '../s2/exec.mjs';

const opt = args(process.argv.slice(2));
if (!opt.root || !opt.out || !opt.before || !opt.after) {
  console.error('usage: node compare.mjs --root <suite> --out <dir> --before a,b,c --after x,y,z [--rest <dir> --area a,b]');
  process.exit(2);
}
const load = (name) => JSON.parse(readFileSync(join(opt.out, 'cover', `${name}.json`), 'utf8'));

let rest = null;
if (opt.rest) {
  const area = new Set(String(opt.area || '').split(',').filter(Boolean).map((a) => `${a}.json`));
  rest = new Set();
  for (const f of readdirSync(opt.rest)) {
    if (area.has(f)) continue;
    for (const [p, ls] of Object.entries(JSON.parse(readFileSync(join(opt.rest, f), 'utf8')))) for (const l of ls) rest.add(`${p}:${l}`);
  }
}
const inter = (sets) => new Set([...sets[0]].filter((k) => sets.every((s) => s.has(k))));
const unite = (sets) => new Set(sets.flatMap((s) => [...s]));

function oneRep(set) {
  const all = new Set(), setup = new Set(), tests = new Map();
  for (const [file, f] of Object.entries(set.files)) {
    for (const k of [...f.setup, ...f.other, ...f.perFile]) all.add(k);
    for (const k of f.setup) setup.add(k);
    for (const [name, keys] of Object.entries(f.tests)) {
      tests.set(`${file} :: ${name}`, new Set(keys));
      for (const k of keys) all.add(k);
    }
  }
  return { all, setup, tests };
}

function summarise(names, root = opt.root) {
  const reps = names.map((n) => oneRep(load(n)));
  const first = load(names[0]);
  let fileLines = 0;
  for (const file of Object.keys(first.files)) fileLines += readFileSync(join(root, file), 'utf8').replace(/\n$/, '').split('\n').length;
  const ever = unite(reps.map((r) => r.all));
  const always = inter(reps.map((r) => r.all));
  const setupEver = unite(reps.map((r) => r.setup));
  const ids = [...reps[0].tests.keys()];
  const stableTest = new Map(ids.map((id) => [id, inter(reps.map((r) => r.tests.get(id) || new Set()))]));
  const everTest = new Map(ids.map((id) => [id, unite(reps.map((r) => r.tests.get(id) || new Set()))]));
  const owners = new Map();
  for (const s of everTest.values()) for (const k of s) owners.set(k, (owners.get(k) || 0) + 1);
  const perTest = ids.map((id) => {
    const keys = stableTest.get(id);
    const unique = [...keys].filter((k) => owners.get(k) === 1 && !setupEver.has(k));
    return { id, covered: keys.size, notSetup: [...keys].filter((k) => !setupEver.has(k)).length, unique: unique.length, uniqueKeys: unique.sort() };
  });
  return {
    reps: names.length, files: Object.keys(first.files).length, tests: ids.length, fileLines,
    ever, always, flaky: new Set([...ever].filter((k) => !always.has(k))), setupEver,
    testDriven: new Set([...ever].filter((k) => !setupEver.has(k))),
    perTest,
    uniqueLines: perTest.reduce((n, t) => n + t.unique, 0),
    zeroUnique: perTest.filter((t) => t.unique === 0).map((t) => t.id),
    suiteOnly: rest ? [...ever].filter((k) => !rest.has(k)) : null,
  };
}

const bNames = String(opt.before).split(','), aNames = String(opt.after).split(',');
const before = summarise(bNames, opt["before-root"] || opt.root), after = summarise(aNames);
const minus = (a, b) => [...a].filter((k) => !b.has(k)).sort();
const lost = minus(before.ever, after.ever);
const lostStable = lost.filter((k) => before.always.has(k));
const lostFlaky = lost.filter((k) => !before.always.has(k));
const gained = minus(after.ever, before.ever);
const notEveryAfter = minus(before.ever, after.always); // stricter: before lines an after repeat missed
const byFile = (keys) => keys.reduce((m, k) => { const p = k.slice(0, k.lastIndexOf(':')); m[p] = (m[p] || 0) + 1; return m; }, {});

const B = bNames[0].replace(/-r\d+$/, ''), A = aNames[0].replace(/-r\d+$/, '');
const row = (label, f) => `| ${label} | ${f(before)} | ${f(after)} |`;
const lines = [
  `| | ${B} (${before.reps} repeats) | ${A} (${after.reps} repeats) |`, '|---|---:|---:|',
  row('Test files', (s) => s.files),
  row('Tests', (s) => s.tests),
  row('Test-file lines', (s) => s.fileLines),
  row('Covered lines, any repeat (union)', (s) => s.ever.size),
  row('Covered lines, every repeat', (s) => s.always.size),
  row('Flaky lines (some repeats only)', (s) => s.flaky.size),
  row('Covered lines outside module load', (s) => s.testDriven.size),
  row('Lines unique to one test (within the side)', (s) => s.uniqueLines),
  row('Tests with zero unique lines', (s) => s.zeroUnique.length),
  ...(rest ? [row('Lines no other test file in the suite covers', (s) => s.suiteOnly.length)] : []),
];
const ok = lost.length === 0;
const out = {
  before: bNames, after: aNames, guardrail: ok ? 'pass' : 'fail',
  lost, lostStable, lostFlaky, notEveryAfter, gained: gained.length, gainedByFile: byFile(gained), gainedKeys: gained,
  flakyBefore: [...before.flaky].sort(), flakyAfter: [...after.flaky].sort(),
  sets: Object.fromEntries([[B, before], [A, after]].map(([k, s]) => [k, {
    reps: s.reps, files: s.files, tests: s.tests, fileLines: s.fileLines, ever: s.ever.size, always: s.always.size, flaky: s.flaky.size,
    flakyByFile: byFile([...s.flaky]), testDriven: s.testDriven.size, uniqueLines: s.uniqueLines, zeroUnique: s.zeroUnique,
    suiteOnly: s.suiteOnly?.length ?? null, perTest: s.perTest,
  }])),
};
writeFileSync(join(opt.out, `compare-${bNames[0]}-${aNames[0]}.json`), JSON.stringify(out, null, 1));
console.log(lines.join('\n'));
console.log(`\nGuardrail (after-union contains before-union): ${out.guardrail}. Lost ${lost.length} (stable ${lostStable.length}, flaky ${lostFlaky.length}); gained ${gained.length}. Before lines missed by at least one after repeat: ${notEveryAfter.length}.`);
console.log(`Flaky lines by file, ${B}: ${JSON.stringify(byFile([...before.flaky]))}`);
console.log(`Flaky lines by file, ${A}: ${JSON.stringify(byFile([...after.flaky]))}`);
if (lost.length) console.log(`Lost: ${lost.slice(0, 60).join(' ')}${lost.length > 60 ? ' …' : ''}`);
process.exit(ok ? 0 : 1);
