// Runs one test file under the mutant hook (spike S3's runner, reworked): one `node --test --test-isolation=none`
// process per file, killed as a process group at its timeout, with our reporter writing to a private file.
// Nothing is written inside the project: reports, marks and mutant specs live in a temporary directory.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const HOOK_URL = pathToFileURL(fileURLToPath(new URL('./hook.mjs', import.meta.url))).href;
const REPORTER = fileURLToPath(new URL('./reporter.mjs', import.meta.url));

/** Thrown when the test environment cannot be trusted (spec E1: exit 3). */
export class EnvironmentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EnvironmentError';
    this.code = 'environment';
    this.exit = 3;
  }
}

/** The environment for test processes: the caller's, plus `runners.node.env`, plus the hook preload. */
export function testEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // A parent `node --test` (Cupel's own tests) must not turn the child into a sub-reporter; coverage is not wanted.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_V8_COVERAGE;
  delete env.CUPEL_MUTANT;
  delete env.CUPEL_MARKS;
  delete env.CUPEL_REPORT;
  env.NODE_OPTIONS = [env.NODE_OPTIONS, `--import=${HOOK_URL}`].filter(Boolean).join(' ');
  return env;
}

/** Runs async tasks with at most `jobs` at once; results come back in input order. The first error stops it. */
export async function pool(items, jobs, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, async () => {
    while (!failed && next < items.length) {
      const k = next++;
      try {
        results[k] = await fn(items[k], k);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  const settled = await Promise.allSettled(workers);
  const rejected = settled.find((s) => s.status === 'rejected');
  if (rejected) throw rejected.reason;
  return results;
}

let counter = 0;

/**
 * Runs one test file. Returns { code, signal, timedOut, wallMs, results, started, ended, stderr }, where `results`
 * are the reporter's lines and `started`/`ended` the full names of tests whose beforeEach/afterEach ran.
 */
export function runTestFile({ root, file, env, tmp, mutantSpec = null, timeoutMs }) {
  const n = ++counter;
  const report = join(tmp, `report-${n}.jsonl`);
  const marks = join(tmp, `marks-${n}.txt`);
  const childEnv = { ...env, CUPEL_REPORT: report, CUPEL_MARKS: marks };
  if (mutantSpec) childEnv.CUPEL_MUTANT = mutantSpec;
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, ['--test', '--test-isolation=none', `--test-reporter=${REPORTER}`, file], {
      cwd: root, env: childEnv, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let timedOut = false;
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, Math.max(1, Math.round(timeoutMs)));
    let finished = false;
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Children the tests left behind in the group do not outlive the run.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      const wallMs = Math.round(performance.now() - started);
      const results = existsSync(report)
        ? readFileSync(report, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
        : [];
      const startedTests = [];
      const endedTests = [];
      if (existsSync(marks)) {
        for (const l of readFileSync(marks, 'utf8').split('\n')) {
          if (l.startsWith('S ')) startedTests.push(l.slice(2));
          else if (l.startsWith('E ')) endedTests.push(l.slice(2));
        }
      }
      resolve({ code, signal, timedOut, wallMs, results, started: startedTests, ended: endedTests, stderr });
    };
    child.on('error', (error) => { stderr += String(error); finish(-1, null); });
    child.on('close', finish);
  });
}

/** Whether a failing reporter line is node:test's report of a file that failed to load. */
export const isFileFailure = (file, line) => !line.suite && (line.t === file || line.t === basename(file));
