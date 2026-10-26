import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export class JestCollectorError extends Error {
  constructor(message) { super(message); this.name = 'JestCollectorError'; this.code = 'environment'; this.exit = 3; }
}

export function resolveJest(root) {
  const require = createRequire(join(root, 'package.json'));
  let packagePath;
  try { packagePath = require.resolve('jest/package.json'); }
  catch { throw new JestCollectorError(`Jest is not resolvable from ${root}`); }
  const version = JSON.parse(readFileSync(packagePath, 'utf8')).version;
  if (version !== '30.2.0') throw new JestCollectorError(`unsupported Jest ${version}; this adapter requires exactly 30.2.0`);
  return { entry: join(dirname(packagePath), 'bin/jest.js'), version };
}

export function runJest(root, entry, args, env = process.env, timeoutMs = 120000) {
  return new Promise((resolveRun) => {
    const start = performance.now();
    const child = spawn(process.execPath, [entry, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '', stderr = '', timedOut = false;
    for (const [stream, append] of [[child.stdout, (s) => stdout = (stdout + s).slice(-1 << 22)],
      [child.stderr, (s) => stderr = (stderr + s).slice(-1 << 22)]]) {
      stream.setEncoding('utf8').on('data', append);
    }
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutMs);
    child.on('error', (error) => { stderr += String(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, timedOut, stdout, stderr, wallMs: Math.round(performance.now() - start) });
    });
  });
}

function parseJson(text, label) {
  try { return JSON.parse(text); }
  catch { throw new JestCollectorError(`${label} is missing or malformed JSON`); }
}

export async function effectiveJestConfig(root, jest, env = process.env) {
  const result = await runJest(root, jest.entry, ['--showConfig', '--rootDir', root], env);
  if (result.timedOut || result.code !== 0) throw new JestCollectorError(`Jest configuration failed: ${result.stderr.trim().slice(-500)}`);
  const value = parseJson(result.stdout, 'Jest --showConfig');
  if (value.configs?.length !== 1) throw new JestCollectorError('Jest with one project is required');
  const config = value.configs[0];
  const require = createRequire(join(root, 'package.json'));
  for (const packageName of ['jest-circus', 'jest-environment-node']) {
    const version = require(`${packageName}/package.json`).version;
    if (version !== '30.2.0') throw new JestCollectorError(`${packageName} ${version} is unsupported; expected 30.2.0`);
  }
  const circus = realpathSync(require.resolve('jest-circus/runner'));
  const nodeEnvironment = realpathSync(require.resolve('jest-environment-node'));
  if (!config.testRunner || realpathSync(config.testRunner) !== circus)
    throw new JestCollectorError('Jest testRunner must be the project-owned jest-circus runner');
  if (!config.testEnvironment || realpathSync(config.testEnvironment) !== nodeEnvironment)
    throw new JestCollectorError('Jest testEnvironment must be the project-owned node environment');
  if (config.extensionsToTreatAsEsm?.length || config.workerThreads || value.globalConfig?.workerThreads)
    throw new JestCollectorError('Jest native ESM and worker threads are not validated');
  return config;
}

export async function listJestFiles(root, jest, requested = [], env = process.env) {
  const args = ['--listTests', '--json', '--runInBand', '--rootDir', root, ...requested];
  const result = await runJest(root, jest.entry, args, env);
  if (result.timedOut || result.code !== 0) throw new JestCollectorError(`Jest test listing failed: ${result.stderr.trim().slice(-500)}`);
  const files = parseJson(result.stdout, 'Jest --listTests');
  if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string'))
    throw new JestCollectorError('Jest found no test files');
  return files.map(file => resolve(file));
}

export function reportPath(out, file) {
  return join(out, createHash('sha256').update(file).digest('hex') + '.json');
}

export async function executeJest({ root, jest, out, settings, files, timeoutMs = 120000, env = process.env,
  environment = new URL('./environment.cjs', import.meta.url) }) {
  const settingsPath = join(out, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ ...settings, root, out }));
  const resultsPath = join(out, 'results.json');
  const childEnv = { ...env, CUPEL_JEST_SETTINGS: settingsPath };
  const args = ['--runInBand', '--no-cache', '--no-coverage', '--json', '--outputFile', resultsPath,
    '--env', fileURLToPath(environment), '--rootDir', root, '--runTestsByPath', ...files];
  const run = await runJest(root, jest.entry, args, childEnv, timeoutMs);
  if (run.timedOut || run.signal) throw new JestCollectorError(`Jest run did not complete (${run.signal ?? 'timeout'})`);
  if (!existsSync(resultsPath)) throw new JestCollectorError(`Jest did not write complete results: ${run.stderr.trim().slice(-500)}`);
  const summary = parseJson(readFileSync(resultsPath, 'utf8'), 'Jest result');
  if (!Array.isArray(summary.testResults) || summary.testResults.length !== files.length)
    throw new JestCollectorError('Jest result set is incomplete');
  const suites = [];
  for (const file of files) {
    const path = reportPath(out, file);
    if (!existsSync(path)) throw new JestCollectorError(`Jest hook data missing for ${relative(root, file)}`);
    const hook = parseJson(readFileSync(path, 'utf8'), `Jest hook ${file}`);
    const result = summary.testResults.find(row => resolve(row.name) === file);
    if (!result || !Array.isArray(result.assertionResults) || result.assertionResults.length !== hook.tests?.length)
      throw new JestCollectorError(`Jest result mismatch for ${relative(root, file)}`);
    const actual = new Map();
    for (const assertion of result.assertionResults) {
      const key = [...(assertion.ancestorTitles ?? []), assertion.title].join(' > ');
      const rows = actual.get(key) ?? [];
      rows.push(assertion.status);
      actual.set(key, rows);
    }
    for (const test of hook.tests) {
      const status = actual.get(test.fullName)?.shift();
      if (!status || (status === 'pending' || status === 'todo' ? 'skipped' : status) !== test.status)
        throw new JestCollectorError(`Jest hook/result status mismatch for ${test.id}`);
    }
    suites.push(hook);
  }
  if (run.code !== 0 && !summary.numFailedTests && !summary.numFailedTestSuites)
    throw new JestCollectorError(`Jest exited ${run.code} without a reported test failure`);
  return { suites, summary, run };
}
