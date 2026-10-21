#!/usr/bin/env node
// S9 (H4): what does reading history cost live? Git commands may not run in the Assay or CodeCrystal repositories
// from this worktree, so this script replays each exported history into a synthetic repository of the same shape and
// times `git log --numstat` and `git blame --line-porcelain` there.
//
// Usage: node plans/spikes/s9/synth.mjs --work <dir inside this worktree, git-ignored> [--suite assay|cc|all]
//
// Replay. Non-merge commits are applied oldest first as one linear chain (merges dropped: their numstat is not in the
// export), each with its real date and path list. A file change of +a/-d lines removes d lines and inserts a lines in
// up to three hunks at seeded random positions; lines are unique synthetic text. Binary changes are skipped. The
// result has the same commits per path, the same churn and about the same file sizes at HEAD, but not the same text,
// so diff costs are similar, not identical. The repository is bare; blame runs on HEAD.
// Timings are wall time of each git command (sequential), and of all blames run 8 at a time.

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { S9, SUITES, args, parseHistory, isMerge, blameName, mulberry32 } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const opt = args(process.argv.slice(2), { suite: 'all' });
if (!opt.work) throw new Error('--work <dir> is required');
const suites = opt.suite === 'all' ? Object.keys(SUITES) : [opt.suite];
const resultsPath = join(HERE, 'results/cost.json');
const results = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : {};

const git = (repo, a, o = {}) => execFileSync('git', ['--git-dir', repo, ...a], { maxBuffer: 1 << 30, ...o });

function buildStream(log, file) {
  const rand = mulberry32(20261021);
  const state = new Map(); // path -> lines
  let serial = 0;
  const out = createWriteStream(file);
  const commits = log.filter((c) => !isMerge(c)).reverse();
  let mark = 0;
  const chunks = [];
  for (const c of commits) {
    const changed = [];
    for (const f of c.files) {
      if (f.add === null) continue;
      let lines = state.get(f.path) ?? [];
      let del = Math.min(f.del, lines.length), add = f.add;
      const hunks = Math.max(1, Math.min(3, Math.ceil(rand() * 3), Math.max(del, add)));
      for (let h = 0; h < hunks; h++) {
        const d = h === hunks - 1 ? del : Math.floor(del / hunks), a = h === hunks - 1 ? add : Math.floor(add / hunks);
        const pos = Math.floor(rand() * (lines.length - d + 1));
        const ins = Array.from({ length: a }, () => `line ${++serial} ${(serial * 2654435761 >>> 0).toString(36)} of ${f.path}`);
        lines = [...lines.slice(0, pos), ...ins, ...lines.slice(pos + d)];
        del -= d; add -= a;
      }
      state.set(f.path, lines);
      changed.push(f.path);
    }
    mark++;
    const msg = `${c.subject}\n`;
    chunks.push(`commit refs/heads/main\nmark :${mark}\ncommitter Synth <synth@example.invalid> ${c.date} +0000\ndata ${Buffer.byteLength(msg)}\n${msg}`);
    for (const p of changed) {
      const lines = state.get(p);
      if (!lines.length) { chunks.push(`D ${p}\n`); state.delete(p); continue; }
      const body = `${lines.join('\n')}\n`;
      chunks.push(`M 100644 inline ${p}\ndata ${Buffer.byteLength(body)}\n${body}`);
    }
    chunks.push('\n');
    if (chunks.length > 2000) { out.write(chunks.join('')); chunks.length = 0; }
  }
  out.write(chunks.join(''));
  return new Promise((res) => out.end(() => res({ commits: commits.length, paths: state.size, lines: [...state.values()].reduce((s, l) => s + l.length, 0), state })));
}

function time(fn) { const t = performance.now(); const r = fn(); return [Math.round(performance.now() - t), r]; }

async function parallel(repo, files, n) {
  const t = performance.now();
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < files.length) {
      const f = files[i++];
      await new Promise((res, rej) => { const p = spawn('git', ['--git-dir', repo, 'blame', '--line-porcelain', 'HEAD', '--', f], { stdio: ['ignore', 'ignore', 'inherit'] }); p.on('exit', (c) => (c ? rej(new Error(`blame ${f}: ${c}`)) : res())); });
    }
  }));
  return Math.round(performance.now() - t);
}

for (const suite of suites) {
  const log = parseHistory(join(S9, SUITES[suite].history));
  const dir = join(opt.work, suite);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const repo = join(dir, 'repo.git');
  execFileSync('git', ['init', '--quiet', '--bare', repo]);
  const streamFile = join(dir, 'stream.fi');
  const built = await buildStream(log, streamFile);
  const [importMs] = time(() => execFileSync('git', ['--git-dir', repo, 'fast-import', '--quiet'], { input: readFileSync(streamFile), maxBuffer: 1 << 30 }));
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  // The test files the export blamed, as present in the replayed HEAD.
  const files = [...built.state.keys()].filter((p) => existsSync(join(S9, SUITES[suite].blame, blameName(p)))).sort();
  const blameLines = files.reduce((s, p) => s + built.state.get(p).length, 0);
  const [logMs, logOut] = time(() => git(repo, ['log', '--no-renames', '--numstat', '--format=commit %H%nparents %P%nauthor %an <%ae>%ndate %at%nsubject %s%nbody%n%b%nendbody']));
  const [blameMs] = time(() => { for (const f of files) git(repo, ['blame', '--line-porcelain', 'HEAD', '--', f]); });
  const blame8Ms = await parallel(repo, files, 8);
  // Per-file cost against the file's commit count, for the largest and most-changed files.
  const touches = new Map();
  for (const c of log) if (!isMerge(c)) for (const f of c.files) touches.set(f.path, (touches.get(f.path) ?? 0) + 1);
  const perFile = files.map((f) => ({ f, commits: touches.get(f) ?? 0, lines: built.state.get(f).length })).sort((a, b) => b.commits - a.commits).slice(0, 5)
    .map((x) => { const [ms] = time(() => git(x.f && repo, ['blame', '--line-porcelain', 'HEAD', '--', x.f])); return { ...x, ms }; });
  results[suite] = {
    replay: { commits: built.commits, pathsAtHead: built.paths, linesAtHead: built.lines, importMs },
    blamedFiles: files.length, blamedLines: blameLines, gitLogMs: logMs, gitLogBytes: logOut.length,
    blameSequentialMs: blameMs, blameParallel8Ms: blame8Ms, msPerFile: Math.round(blameMs / files.length), mostChangedFiles: perFile,
    machine: { cpus: (await import('node:os')).cpus().length, loadavg: (await import('node:os')).loadavg().map((x) => +x.toFixed(1)), git: execFileSync('git', ['--version']).toString().trim() },
  };
  console.log(suite, JSON.stringify(results[suite]));
}
writeFileSync(resultsPath, JSON.stringify(results, null, 1));
