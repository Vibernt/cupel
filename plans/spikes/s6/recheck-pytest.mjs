#!/usr/bin/env node
// S6: re-check pytest retire candidates per process (D7): run each candidate alone with the coverage plugin, so
// first-touch credit, sys.modules swaps by earlier tests and shared session fixtures cannot hide its lines.
//
// Usage: node plans/spikes/s6/recheck-pytest.mjs --report <report.json> --out <dir> [--jobs 4] [--advice retire]
// Writes <out>/recheck.json: [{ id, file, name, ran, pass, lines: ['path:line'], wallMs }]. The setup bucket (imports,
// collection) is left out, as in the full run; the test's own bucket is what counts.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args } from '../s2/exec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const opt = args(process.argv.slice(2), { jobs: '4', advice: 'retire' });
const report = JSON.parse(readFileSync(opt.report, 'utf8'));
const wanted = new Set(opt.advice.split(','));
const todo = report.tests.filter((t) => wanted.has(t.advice));
mkdirSync(join(opt.out, 'runs'), { recursive: true });
const results = [];
let next = 0;
async function worker() {
  while (next < todo.length) {
    const k = next++;
    const t = todo[k];
    const out = join(opt.out, 'runs', `${k}.json`);
    rmSync(out, { force: true });
    const t0 = Date.now();
    await new Promise((res) => {
      const p = spawn(join(HERE, 'run-pytest.sh'), ['coverage', out, t.id], { stdio: 'ignore' });
      const timer = setTimeout(() => p.kill('SIGKILL'), 300000);
      p.on('exit', () => { clearTimeout(timer); res(); });
    });
    let rec = { id: t.id, file: t.file, name: t.name, ran: 0, pass: 0, wallMs: Date.now() - t0, lines: [] };
    if (existsSync(out)) {
      const d = JSON.parse(readFileSync(out, 'utf8'));
      const mine = d.tests.filter((x) => x.id === t.id);
      rec.ran = mine.length;
      rec.pass = mine.filter((x) => x.outcome === 'passed').length;
      const lines = new Set();
      for (const x of mine) for (const [p, ls] of Object.entries(x.lines)) for (const l of ls) lines.add(`${p}:${l}`);
      rec.lines = [...lines].sort();
      rmSync(out, { force: true });
    }
    results.push(rec);
    if (results.length % 20 === 0) console.log(`${results.length}/${todo.length}`);
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: Number(opt.jobs) }, worker));
results.sort((a, b) => (a.id < b.id ? -1 : 1));
writeFileSync(join(opt.out, 'recheck.json'), JSON.stringify(results));
console.log(`rechecked ${results.length} tests in ${((Date.now() - t0) / 1000).toFixed(0)} s; ran!=1: ${results.filter((r) => r.ran !== 1).length}; not passed: ${results.filter((r) => r.pass !== 1).length}`);
