// Runs one test file under the mutant hook (spike S3's runner, reworked): one `node --test --test-isolation=none`
// process per file, killed as a process group at its timeout, with our reporter writing to a private file.
// Nothing is written inside the project: reports, marks and mutant specs live in a temporary directory.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { killLeftovers, killTree } from '../process-tree.mjs';

// Node renamed --experimental-test-isolation to --test-isolation in 23.6; Node 22 accepts only the old name.
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map(Number);
const ISOLATION_FLAG = NODE_MAJOR > 23 || (NODE_MAJOR === 23 && NODE_MINOR >= 6) ? '--test-isolation=none' : '--experimental-test-isolation=none';

const HOOK_URL = pathToFileURL(fileURLToPath(new URL('./hook.mjs', import.meta.url))).href;
// A file URL: node:test loads reporters as modules, and on Windows a plain D:\\ path reads as a URL with scheme d:.
const REPORTER = new URL('./reporter.mjs', import.meta.url).href;

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
  delete env.CUPEL_LOADERS;
  delete env.CUPEL_REPORT;
  // First, so the hook registers before a loader the project sets up (`--import tsx`) and sits inside it.
  env.NODE_OPTIONS = [`--import=${HOOK_URL}`, env.NODE_OPTIONS].filter(Boolean).join(' ');
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
 * Runs one test file. Returns { code, signal, timedOut, cut, wallMs, results, started, ended, stderr, pid }, where
 * `results` are the reporter's lines and `started`/`ended` the full names of tests whose beforeEach/afterEach ran.
 * `stopAt` (a performance.now() time) kills the run when the time budget ends: then `cut` is true.
 */
export function runTestFile({ root, file, env, tmp, mutantSpec = null, timeoutMs, stopAt = Infinity }) {
  const n = ++counter;
  const report = join(tmp, `report-${n}.jsonl`);
  const marks = join(tmp, `marks-${n}.txt`);
  const childEnv = { ...env, CUPEL_REPORT: report, CUPEL_MARKS: marks };
  if (mutantSpec) childEnv.CUPEL_MUTANT = mutantSpec;
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, ['--test', ISOLATION_FLAG, `--test-reporter=${REPORTER}`, file], {
      cwd: root, env: childEnv, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let timedOut = false;
    let cut = false;
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    const budget = stopAt - started;
    const byBudget = budget < timeoutMs;
    const timer = setTimeout(() => {
      if (byBudget) cut = true;
      else timedOut = true;
      killTree(child);
    }, Math.max(1, Math.round(Math.min(timeoutMs, budget))));
    let finished = false;
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Children the tests left behind in the group do not outlive the run.
      killLeftovers(child);
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
      resolve({ code, signal, timedOut, cut, wallMs, results, started: startedTests, ended: endedTests, stderr, pid: child.pid });
    };
    child.on('error', (error) => { stderr += String(error); finish(-1, null); });
    child.on('close', finish);
  });
}

/** Whether a failing reporter line is node:test's report of a file that failed to load. */
export const isFileFailure = (file, line) => !line.suite && (line.t === file || line.t === basename(file));

let probed = null;

/**
 * Whether this Node has the module-hook bugs that break a project's loader under Cupel's sync hook, probed once in
 * `dir` (two small node processes) rather than read from a version table:
 *  - asyncCjs: with sync and async hooks both registered, an ESM import of a CommonJS package fails
 *    (ERR_INVALID_RETURN_PROPERTY_VALUE; nodejs/node#59929, fixed in 22.22.3, 24.11.1 and 25.1.0, never in 23);
 *  - unknownExtension: with any sync hook registered, require() of an extension only a loader handles fails
 *    (ERR_UNKNOWN_FILE_EXTENSION; seen on 22.22.0, not on 22.23.1 or 26.7.0).
 */
export function hookBugs(dir) {
  if (probed) return probed;
  mkdirSync(join(dir, 'node_modules/cupel-probe'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/cupel-probe/package.json'), '{"name":"cupel-probe","main":"index.js"}');
  writeFileSync(join(dir, 'node_modules/cupel-probe/index.js'), 'exports.ok = 1;\n');
  writeFileSync(join(dir, 'probe-hooks.mjs'), 'export async function load(url, context, nextLoad) { return nextLoad(url, context); }\n');
  writeFileSync(join(dir, 'probe-async.mjs'), "import { register } from 'node:module';\nregister('./probe-hooks.mjs', import.meta.url);\nawait import('cupel-probe');\n");
  writeFileSync(join(dir, 'probe-ext.cjs'), "require('node:module')._extensions['.cupelx'] = (m, f) => m._compile('module.exports = 1;', f);\nrequire('./probe.cupelx');\n");
  writeFileSync(join(dir, 'probe.cupelx'), '');
  const env = { ...process.env };
  for (const k of ['NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'NODE_V8_COVERAGE', 'CUPEL_MUTANT', 'CUPEL_MARKS', 'CUPEL_REPORT', 'CUPEL_LOADERS']) delete env[k];
  const fails = (file) => spawnSync(process.execPath, ['--no-warnings', `--import=${HOOK_URL}`, file], { cwd: dir, env, stdio: 'ignore' }).status !== 0;
  probed = { asyncCjs: fails('probe-async.mjs'), unknownExtension: fails('probe-ext.cjs') };
  return probed;
}
