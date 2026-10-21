#!/usr/bin/env node
// S6: re-check retire candidates with S2's method A (one process per test, NODE_V8_COVERAGE), as D7 says.
// Removes method B's blind spots for these tests: leaked async work that lands in another test, and lines a
// test reaches only when run alone.
//
// Usage: node plans/spikes/s6/recheck-node.mjs --root <suite> --report <report.json> --out <dir> [--jobs 6] [--advice retire]
// Writes <out>/recheck.json: [{ id, file, name, ran, pass, lines: ['path:line'], wallMs }].
// Whole-repo scope (minus tests/, node_modules, dot-directories), the same line rule as S2.

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args, readNdjson } from '../s2/exec.mjs';
import { LineRule } from '../s2/lines.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const opt = args(process.argv.slice(2), { jobs: '6', advice: 'retire' });
const report = JSON.parse(readFileSync(opt.report, 'utf8'));
const wanted = new Set(opt.advice.split(','));
const todo = report.tests.filter((t) => wanted.has(t.advice) && !t.name.includes(' > '));
const TOP = readdirSync(opt.root).filter((n) => !n.startsWith('.') && n !== 'tests' && n !== 'node_modules')
  .map((n) => (statSync(join(opt.root, n)).isDirectory() ? `${n}/` : n));
const rule = new LineRule(opt.root, TOP);
const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` };
delete env.NODE_OPTIONS;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
mkdirSync(opt.out, { recursive: true });
const results = [];
let next = 0;
async function worker() {
  while (next < todo.length) {
    const t = todo[next++];
    const dir = join(opt.out, 'runs', String(next));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'v8'), { recursive: true });
    const t0 = Date.now();
    await new Promise((res) => {
      const p = spawn(process.execPath, [`--test-name-pattern=^${escape(t.name)}$`, `--test-reporter=${join(HERE, '../s2/reporter.mjs')}`,
        `--test-reporter-destination=${join(dir, 'tests.ndjson')}`, t.file], { cwd: opt.root, env: { ...env, NODE_V8_COVERAGE: join(dir, 'v8') }, stdio: 'ignore' });
      const timer = setTimeout(() => p.kill('SIGKILL'), 120000);
      p.on('exit', () => { clearTimeout(timer); res(); });
    });
    const ran = readNdjson(join(dir, 'tests.ndjson')).filter((x) => x.type !== 'suite' && !x.skip);
    const lines = new Set();
    for (const f of readdirSync(join(dir, 'v8')).filter((x) => x.endsWith('.json'))) {
      try {
        for (const [p, ls] of rule.lineSets(JSON.parse(readFileSync(join(dir, 'v8', f), 'utf8')).result)) for (const l of ls) lines.add(`${p}:${l}`);
      } catch { /* a truncated file from a killed child */ }
    }
    rmSync(dir, { recursive: true, force: true });
    results.push({ id: t.id, file: t.file, name: t.name, ran: ran.length, pass: ran.filter((x) => x.event === 'pass').length, wallMs: Date.now() - t0, lines: [...lines].sort() });
    if (results.length % 50 === 0) console.log(`${results.length}/${todo.length}`);
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: Number(opt.jobs) }, worker));
results.sort((a, b) => (a.id < b.id ? -1 : 1));
writeFileSync(join(opt.out, 'recheck.json'), JSON.stringify(results));
console.log(`rechecked ${results.length} tests in ${((Date.now() - t0) / 1000).toFixed(0)} s; ran!=1: ${results.filter((r) => r.ran !== 1).length}; not passed: ${results.filter((r) => r.pass !== 1).length}`);
