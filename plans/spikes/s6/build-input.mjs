#!/usr/bin/env node
// S6: turn collected data into the draft engine's input (one JSON file per suite).
//
// Usage:
//   node plans/spikes/s6/build-input.mjs node   --cov <out-s6/assay> --brittle <brittle.json> [--s3 <out-s3>] [--recheck <recheck.json>] --out <input.json>
//   node plans/spikes/s6/build-input.mjs pytest --cov <coverage.json> --brittle <brittle.json> [--recheck <recheck.json>] --out <input.json>
//
// Input format (what engine.mjs reads):
//   { suite, granularity: 'test', lineKeys: ['path:line', ...], setupLines: [lineIdx],
//     tests: [{ id, file, name, ms, status, lines: [lineIdx], spawned: [...], spawnsInterpreter, brittle: [{kind,line,evidence}],
//               recheckLines?: [lineIdx] (per-process re-check), site (test source location; rows of one
//               parametrized or looped test share it), shape (masked body tokens) }],
//     mutation: null | { files: [path], mutants: [{ id, killers: [testIdx], unnamedKillFiles: [file] }] } }
// Standard library only.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { args } from '../s2/exec.mjs';

const [kind, ...rest] = process.argv.slice(2);
const opt = args(rest);
const keys = [];
const keyIdx = new Map();
const idx = (k) => { let i = keyIdx.get(k); if (i === undefined) { keyIdx.set(k, (i = keys.length)); keys.push(k); } return i; };
const brittle = JSON.parse(readFileSync(opt.brittle, 'utf8')).tests;

function brittleIndex(stripParams) {
  const exact = new Map();
  const patterns = [];
  for (const t of brittle) {
    const k = `${t.file}::${t.name}`;
    exact.set(k, t);
    if (t.pattern) patterns.push({ file: t.file, re: new RegExp(`^${t.pattern}$`), t });
  }
  return (file, name) => {
    const n = stripParams ? name.replace(/\[.*\]$/, '') : name;
    return exact.get(`${file}::${n}`) ?? patterns.find((p) => p.file === file && p.re.test(n))?.t ?? null;
  };
}

let out;
if (kind === 'node') {
  const raw = JSON.parse(readFileSync(join(opt.cov, 'tests.json'), 'utf8'));
  const setup = JSON.parse(readFileSync(join(opt.cov, 'setup.json'), 'utf8'));
  const setupLines = new Set();
  for (const ls of Object.values(setup)) for (const k of ls) setupLines.add(idx(k));
  const find = brittleIndex(false);
  let matched = 0;
  const tests = raw.map((t) => {
    const b = find(t.file, t.name);
    if (b) matched++;
    return {
      id: t.id, file: t.file, name: t.name, ms: t.ms, status: t.status,
      lines: t.lines.map(idx), spawned: t.spawned, spawnsInterpreter: t.spawnsNode,
      brittle: b?.flags ?? [], brittleMatched: !!b, site: b ? `${b.file}:${b.line}` : null, shape: b?.shape ?? null,
    };
  });
  if (opt.recheck) {
    // Per-process (method A) line sets of re-checked tests, from recheck-node.mjs.
    const byId = new Map(tests.map((t, i) => [t.id, i]));
    for (const r of JSON.parse(readFileSync(opt.recheck, 'utf8'))) {
      const i = byId.get(r.id);
      if (i !== undefined && r.ran === 1 && r.pass === 1) tests[i].recheckLines = r.lines.map(idx);
    }
  }
  let mutation = null;
  if (opt.s3) {
    const byName = new Map(); // file::leafName -> [testIdx]
    tests.forEach((t, i) => { const k = `${t.file}::${t.name.split(' > ').pop()}`; byName.set(k, [...(byName.get(k) ?? []), i]); });
    const results = new Map();
    for (const f of ['results.jsonl', 'recheck.jsonl']) {
      for (const line of readFileSync(join(opt.s3, f), 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(line); results.set(r.id, r); }
    }
    const files = new Set();
    const mutants = [];
    let unmatchedNames = 0;
    for (const r of results.values()) {
      files.add(r.file);
      const killers = new Set();
      const unnamed = [];
      if (r.status === 'killed' || r.status === 'timeout') {
        for (const f of r.files) {
          if (!f.killed) continue;
          if (!f.failed.length) { unnamed.push(f.file); continue; }
          for (const n of f.failed) {
            const hit = byName.get(`${f.file}::${n}`);
            if (hit) for (const i of hit) killers.add(i); else { unmatchedNames++; unnamed.push(f.file); }
          }
        }
      }
      mutants.push({ id: r.id, status: r.status, killers: [...killers], unnamedKillFiles: unnamed });
    }
    mutation = { files: [...files].sort(), mutants, unmatchedNames };
  }
  out = { suite: 'assay', granularity: 'test', lineKeys: keys, setupLines: [...setupLines], tests, mutation, brittleMatched: matched };
} else if (kind === 'pytest') {
  const d = JSON.parse(readFileSync(opt.cov, 'utf8'));
  const setupLines = new Set();
  for (const b of ['setup', 'between', 'teardown']) for (const [p, ls] of Object.entries(d[b])) for (const l of ls) setupLines.add(idx(`${p}:${l}`));
  const find = brittleIndex(true);
  let matched = 0;
  const tests = d.tests.map((t) => {
    const name = t.id.split('::').slice(1).join('::');
    const b = find(t.file, name);
    if (b) matched++;
    const lines = [];
    for (const [p, ls] of Object.entries(t.lines)) for (const l of ls) lines.push(idx(`${p}:${l}`));
    const ms = Math.round(1000 * Object.values(t.durations).reduce((a, x) => a + x, 0));
    return {
      id: t.id, file: t.file, name, ms, status: t.outcome, lines, spawned: t.spawned,
      spawnsInterpreter: t.spawned.some((s) => /^python|^pytest|^node$|^crystal$|^cri$|^uv$|^sh$|^bash$/.test(s)),
      watched: t.watched, markers: t.markers, brittle: b?.flags ?? [], brittleMatched: !!b, site: b ? `${b.file}:${b.line}` : null, shape: b?.shape ?? null,
    };
  });
  if (opt.recheck) {
    const byId = new Map(tests.map((t, i) => [t.id, i]));
    for (const r of JSON.parse(readFileSync(opt.recheck, 'utf8'))) {
      const i = byId.get(r.id);
      if (i !== undefined && r.ran === 1 && r.pass === 1) tests[i].recheckLines = r.lines.map(idx);
    }
  }
  out = { suite: 'codecrystal', granularity: 'test', lineKeys: keys, setupLines: [...setupLines], tests, mutation: null, brittleMatched: matched, setupWatched: d.setupWatched };
} else {
  console.error('usage: build-input.mjs node|pytest ...');
  process.exit(2);
}
writeFileSync(opt.out, JSON.stringify(out));
console.log(`${out.suite}: tests ${out.tests.length}, lines ${keys.length}, setup ${out.setupLines.length}, brittle matched ${out.brittleMatched}, mutants ${out.mutation?.mutants.length ?? 0}${out.mutation ? `, unmatched kill names ${out.mutation.unmatchedNames}` : ''}`);
