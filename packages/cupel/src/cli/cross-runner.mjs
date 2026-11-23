// Cross-runner fault testing (test-quality audit, phase 7). Rust faults that
// `cargo test` did not catch, in sources that are also built into an artifact
// other tests load (a WebAssembly module a Worker runs in workerd), get a second
// chance: in a scratch copy of the project the fault is planted, the named build
// step runs, and the tests that load the artifact run. A test that now fails
// catches the fault and is credited. Opt-in and capped, because every fault
// costs a build and a test run:
//
//   "runners": { "cargo": { "mutants": { "crossRunner": {
//     "sources": "crates/core/**", "artifact": "cloud/src/prill.wasm",
//     "build": "sh tools/build-wasm.sh", "maxMutants": 20 } } } }
//
// The project itself is never written; the copy and its build output are removed.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { anyGlobMatches } from '../engine/match.mjs';
import { cmp } from '../engine/order.mjs';
import { copyProject } from '../mutate/index.mjs';
import { runTestFile, testEnv } from '../mutate/runner.mjs';
import { diffMatches, mutantId } from '../mutate-cargo/import.mjs';
import { environment } from './errors.mjs';

/** Applies a cargo-mutants unified diff (one file) to its original text. */
export function applyDiff(text, diff) {
  const lines = text.split('\n');
  const out = [];
  let at = 0;
  const body = diff.split('\n');
  for (let i = 0; i < body.length; i++) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(body[i]);
    if (!hunk) continue;
    const start = Number(hunk[1]) - 1;
    while (at < start) out.push(lines[at++]);
    for (i++; i < body.length && !body[i].startsWith('@@'); i++) {
      const line = body[i];
      if (line.startsWith(' ')) { out.push(lines[at++]); }
      else if (line.startsWith('-')) at++;
      else if (line.startsWith('+')) out.push(line.slice(1));
    }
    i--;
  }
  while (at < lines.length) out.push(lines[at++]);
  return out.join('\n');
}

function shell(command, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, env, shell: true, stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, stderr: String(error) }); });
  });
}

/**
 * crossRunner({ root, cfg, input, mutation, listing, log }) → mutation with
 * survivors in the configured sources re-tested by the tests that load the
 * artifact. `listing` is `cargo mutants --list --json` (with diffs).
 */
export async function crossRunner({ root, cfg, input, mutation, listing, log = () => {} }) {
  const settings = cfg.runners?.cargo?.mutants?.crossRunner;
  if (!settings || !mutation) return mutation;
  const { sources, artifact, build, maxMutants = 20, buildTimeoutSeconds = 600, testTimeoutSeconds = 600 } = settings;
  const loaders = input.tests.filter((t) => (t.loads ?? []).includes(artifact) && t.status === 'passed');
  const files = [...new Set(loaders.map((t) => t.file))].sort(cmp);
  if (!files.length) { log(`cross-runner: no passed test loads ${artifact}; nothing to re-test`); return mutation; }
  const diffs = new Map(listing.map((m) => [mutantId(m), m]));
  const candidates = mutation.mutants.filter((m) => m.status === 'survived' && anyGlobMatches([sources], m.source) && diffs.has(m.id))
    .sort((a, b) => cmp(a.id, b.id)).slice(0, maxMutants);
  if (!candidates.length) return mutation;
  mkdirSync(join(root, '.scratch'), { recursive: true });
  const tmp = mkdtempSync(join(root, '.scratch', 'cupel-cross-'));
  try {
    const copy = copyProject(root, join(tmp, 'project'));
    const env = testEnv(cfg.runners?.node?.env ?? {});
    const runAll = async () => {
      const failed = new Set();
      for (const file of files) {
        const r = await runTestFile({ root: copy, file, env, tmp, timeoutMs: testTimeoutSeconds * 1000 });
        if (r.timedOut) return null;
        for (const line of r.results) if (line.s === 'fail' && !line.suite) failed.add(`${file}::${line.t}`);
      }
      return failed;
    };
    log(`cross-runner: building ${artifact} and running ${files.length} test files once unmutated`);
    const built = await shell(build, { cwd: copy, env: process.env, timeoutMs: buildTimeoutSeconds * 1000 });
    if (built.code !== 0) throw environment(`cross-runner build failed (exit ${built.code}): ${built.stderr.trim().split('\n').slice(-3).join(' | ')}`);
    const baseline = await runAll();
    if (!baseline) throw environment('cross-runner baseline test run timed out');
    const ids = new Set(loaders.map((t) => t.id));
    const updated = new Map();
    let n = 0;
    for (const m of candidates) {
      const entry = diffs.get(m.id);
      const target = join(copy, m.source);
      const original = readFileSync(target, 'utf8');
      if (!diffMatches(entry.diff, original)) throw environment(`${m.source} does not match cargo-mutants' listing; collect again`);
      writeFileSync(target, applyDiff(original, entry.diff));
      try {
        const b = await shell(build, { cwd: copy, env: process.env, timeoutMs: buildTimeoutSeconds * 1000 });
        if (b.code !== 0) continue; // a fault the Wasm build rejects tells nothing about the tests
        const failed = await runAll();
        if (!failed) { updated.set(m.id, { ...m, status: 'timeout', killedBy: [] }); continue; }
        const killers = [...failed].filter((id) => ids.has(id) && !baseline.has(id)).sort(cmp);
        if (killers.length) updated.set(m.id, { ...m, status: 'killed', killedBy: killers });
      } finally { writeFileSync(target, original); }
      log(`cross-runner: ${++n}/${candidates.length} ${m.description ?? m.id}: ${updated.get(m.id)?.status ?? 'still survived'}`);
    }
    if (updated.size) log(`cross-runner: ${updated.size} of ${candidates.length} survivors caught by tests that load ${artifact}`);
    const mutants = mutation.mutants.map((m) => updated.get(m.id) ?? m);
    return { ...mutation, mutants, sampled: mutation.sampled || candidates.length < mutation.mutants.filter((m) => m.status === 'survived' && anyGlobMatches([sources], m.source)).length };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
