import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { effectiveJestConfig, reportPath, resolveJest, runJest, JestCollectorError } from '../../collect/jest/process.mjs';

let counter = 0;
const environment = fileURLToPath(new URL('../../collect/jest/environment.cjs', import.meta.url));
const wrapper = fileURLToPath(new URL('./transform.cjs', import.meta.url));

function wrappedTransforms(config) {
  const transforms = {};
  for (const [pattern, original, originalOptions] of config.transform ?? [])
    transforms[pattern] = [wrapper, { cupelOriginal: original, cupelOptions: originalOptions ?? {} }];
  // Files without a project transformer still need the in-memory load boundary.
  if (!Object.hasOwn(transforms, '^.+\\.[cm]?[jt]sx?$')) transforms['^.+\\.[cm]?[jt]sx?$'] = [wrapper, {}];
  return JSON.stringify(transforms);
}

export class JestMutantRunner {
  constructor(root, cfg, tmp) {
    this.root = root;
    this.tmp = tmp;
    this.jest = resolveJest(root);
    this.mutants = new Map();
    this.env = { ...process.env, ...(cfg.runners?.jest?.env ?? {}) };
    for (const key of ['CUPEL_JEST_MUTANT', 'CUPEL_JEST_SETTINGS', 'NODE_TEST_CONTEXT', 'NODE_V8_COVERAGE']) delete this.env[key];
    // Resolve the transformer only when a mutant needs it. An unawaited probe
    // can outlive a temporary Git baseline and start Jest in a deleted cwd.
    this.config = null;
  }

  spec(spec, text) {
    const parsed = JSON.parse(readFileSync(spec.path, 'utf8'));
    this.mutants.set(spec.path, { path:realpathSync(fileURLToPath(parsed.url)), text, seen:spec.seen });
  }

  async runTestFile({ file, mutantSpec = null, timeoutMs, stopAt = Infinity }) {
    const start = performance.now();
    const out = join(this.tmp, `jest-${++counter}`);
    mkdirSync(out);
    const settings = join(out, 'settings.json');
    writeFileSync(settings, JSON.stringify({ root:this.root, out, sources:[], selected:null }));
    const resultPath = join(out, 'results.json');
    const abs = resolve(this.root, file);
    const env = { ...this.env, CUPEL_JEST_SETTINGS:settings };
    const args = ['--runInBand', '--no-cache', '--no-coverage', '--json', '--outputFile', resultPath,
      '--env', environment, '--rootDir', this.root, '--runTestsByPath', abs];
    if (mutantSpec) {
      const mutant = this.mutants.get(mutantSpec);
      if (!mutant) throw new JestCollectorError('unknown Jest mutant spec');
      env.CUPEL_JEST_MUTANT = JSON.stringify(mutant);
      const config = await (this.config ??= effectiveJestConfig(this.root, this.jest, this.env));
      args.unshift('--transform', wrappedTransforms(config));
    }
    const timeLeft = stopAt - start;
    const byBudget = timeLeft < timeoutMs;
    const run = await runJest(this.root, this.jest.entry, args, env, Math.max(1, Math.min(timeoutMs, timeLeft)));
    if (run.timedOut) return { code:run.code, signal:run.signal, timedOut:!byBudget, cut:byBudget,
      wallMs:run.wallMs, results:[], started:[], ended:[], stderr:run.stderr.slice(-4000) };
    let tests = [];
    const path = reportPath(out, abs);
    if (!existsSync(path)) throw new JestCollectorError(`Jest mutation hook data missing for ${file}: ${run.stderr.trim().slice(-300)}`);
    if (existsSync(path)) {
      let data;
      try { data = JSON.parse(readFileSync(path, 'utf8')); }
      catch { throw new JestCollectorError(`malformed Jest mutation hook for ${file}`); }
      if (!Array.isArray(data.tests) || !data.tests.length || data.tests.some(t => !t.id || !t.status))
        throw new JestCollectorError(`incomplete Jest mutation hook for ${file}`);
      tests = data.tests;
    }
    if (existsSync(resultPath)) {
      let summary;
      try { summary = JSON.parse(readFileSync(resultPath, 'utf8')); }
      catch { throw new JestCollectorError(`malformed Jest mutation result for ${file}`); }
      if (!Array.isArray(summary.testResults) || summary.testResults.length !== 1 ||
          summary.testResults[0].assertionResults?.length !== tests.length)
        throw new JestCollectorError(`incomplete Jest mutation result for ${file}`);
      const statuses = new Map();
      for (const row of summary.testResults[0].assertionResults) {
        const name = [...(row.ancestorTitles ?? []), row.title].join(' > ');
        const list = statuses.get(name) ?? [];
        list.push(row.status === 'pending' || row.status === 'todo' ? 'skipped' : row.status);
        statuses.set(name, list);
      }
      for (const row of tests) if (statuses.get(row.fullName)?.shift() !== row.status)
        throw new JestCollectorError(`Jest mutation result status mismatch for ${row.id}`);
    } else throw new JestCollectorError(`Jest mutation result missing for ${file}`);
    return { code:run.code, signal:run.signal, timedOut:run.timedOut && !byBudget, cut:run.timedOut && byBudget,
      wallMs:run.wallMs, results:tests.map(t => ({ s:t.status === 'failed' ? 'fail' : t.status === 'passed' ? 'pass' : 'skip', t:t.name })),
      started:tests.map(t => t.name), ended:tests.filter(t => t.status).map(t => t.name), stderr:run.stderr.slice(-4000) };
  }
}
