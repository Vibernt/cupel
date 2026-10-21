#!/usr/bin/env node
// S6: collect per-test coverage for a node:test suite with S2's method B (whole-repo scope), then reduce it to
// the draft engine's input format.
//
// Usage:
//   node plans/spikes/s6/collect-node.mjs run    --root /abs/assay-s6 --out /abs/out-s6/assay [--plain]
//   node plans/spikes/s6/collect-node.mjs reduce --root /abs/assay-s6 --out /abs/out-s6/assay
//
// run:    one ordinary `node --test tests/*.test.mjs` with `--import node-hook.mjs` (CUPEL_S2_FORMAT=lines), and the
//         S2 JSON reporter for pass/fail. With --plain, also a plain run first, for the overhead.
// reduce: writes <out>/tests.json: one record per leaf test
//         { id, file, name, status, ms, spawnsNode, spawned, lines: ['path:line', ...] }
//         plus <out>/setup.json (lines covered by module load, between and teardown segments, per file).
// Standard library only.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timed, args, readNdjson } from '../s2/exec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);
const opt = args(rest);
if (!opt.root || !opt.out || !['run', 'reduce'].includes(cmd)) {
  console.error('usage: node collect-node.mjs run|reduce --root <suite> --out <dir> [--plain]');
  process.exit(2);
}
const files = readdirSync(join(opt.root, 'tests')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `tests/${f}`);
const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` };
delete env.NODE_V8_COVERAGE;
delete env.NODE_OPTIONS;

if (cmd === 'run') {
  const runs = [];
  for (const v of opt.plain ? ['plain', 'coverage'] : ['coverage']) {
    const dir = join(opt.out, v);
    mkdirSync(dir, { recursive: true });
    const argv = [process.execPath, '--test', `--test-reporter=${join(HERE, '../s2/reporter.mjs')}`, `--test-reporter-destination=${join(dir, 'tests.ndjson')}`];
    const e = { ...env };
    if (v === 'coverage') {
      argv.push('--import', join(HERE, 'node-hook.mjs'));
      Object.assign(e, { CUPEL_S2_OUT: join(dir, 'b'), CUPEL_S2_ROOT: opt.root, CUPEL_S2_FORMAT: 'lines' });
    }
    const r = timed([...argv, ...files], { cwd: opt.root, env: e, log: join(dir, 'log.txt') });
    const res = readNdjson(join(dir, 'tests.ndjson')).filter((x) => x.type !== 'suite');
    const row = { variant: v, ...r, tests: res.length, pass: res.filter((x) => x.event === 'pass').length, fail: res.filter((x) => x.event === 'fail').length,
      failed: res.filter((x) => x.event === 'fail').map((x) => `${x.file?.split('/').pop()} :: ${x.name}`) };
    runs.push(row);
    console.log(JSON.stringify(row));
  }
  writeFileSync(join(opt.out, `runs-${Date.now()}.json`), JSON.stringify(runs, null, 1));
}

if (cmd === 'reduce') {
  const dir = join(opt.out, 'coverage', 'b');
  const results = readNdjson(join(opt.out, 'coverage', 'tests.ndjson'));
  const status = new Map();
  for (const r of results) if (r.type !== 'suite') status.set(`${r.file?.replace(`${opt.root}/`, '')}::${r.name}`, r.event);
  const tests = [];
  const setup = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json') && !x.endsWith('.write.json'))) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const file = d.file.replace(`${opt.root}/`, '');
    const own = new Map();
    const setupLines = new Set();
    const ms = new Map();
    for (const s of d.segments) {
      const lines = [];
      for (const [p, ls] of Object.entries(s.lines ?? {})) for (const l of ls) lines.push(`${p}:${l}`);
      if (s.kind === 'test') {
        for (const o of s.owners) {
          if (!own.has(o)) own.set(o, new Set());
          for (const l of lines) own.get(o).add(l);
          ms.set(o, (ms.get(o) ?? 0) + s.wallMs);
        }
      } else for (const l of lines) setupLines.add(l);
    }
    setup[file] = [...setupLines].sort();
    const names = [...d.tests.map((t) => t.key)];
    for (const t of d.tests) {
      const isLeaf = !names.some((n) => n !== t.key && n.startsWith(`${t.key} > `));
      if (!isLeaf) continue;
      const leafName = t.name.split(' > ').pop();
      tests.push({
        id: `${file} :: ${t.key}`,
        file,
        name: t.key,
        status: status.get(`${file}::${leafName}`) ?? 'unknown',
        ms: Math.round(ms.get(t.key) ?? (t.end - t.start)),
        spawned: t.spawned,
        spawnsNode: t.spawned.some((s) => /:(node|cri|worker)$|^worker$|^fork/.test(s)),
        lines: [...(own.get(t.key) ?? [])].sort(),
      });
    }
  }
  tests.sort((a, b) => (a.id < b.id ? -1 : 1));
  writeFileSync(join(opt.out, 'tests.json'), JSON.stringify(tests));
  writeFileSync(join(opt.out, 'setup.json'), JSON.stringify(setup));
  console.log(`tests ${tests.length}, files ${Object.keys(setup).length}, failed ${tests.filter((t) => t.status === 'fail').length}, unknown ${tests.filter((t) => t.status === 'unknown').length}`);
}
