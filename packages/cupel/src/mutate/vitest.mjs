// Vitest's in-memory mutant transport. The shared mutation session owns selection and classification.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { resolveVitest, splitCommand } from '../collect/vitest/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let counter = 0;

export class VitestMutantRunner {
  constructor(root, cfg, tmp) {
    this.root = root;
    this.tmp = tmp;
    const vitest = resolveVitest(root);
    const runner = cfg.runners?.vitest ?? {};
    this.command = runner.command ? splitCommand(runner.command) : [process.execPath, vitest.entry];
    if (!this.command[0]) throw new Error('runners.vitest.command is empty');
    this.importUrl = vitest.importUrl;
    this.env = { ...process.env, ...(runner.env ?? {}) };
    for (const key of ['NODE_TEST_CONTEXT', 'NODE_V8_COVERAGE', 'CUPEL_MUTANT', 'CUPEL_MARKS', 'CUPEL_REPORT']) delete this.env[key];
    const cache = join(tmp, 'cache');
    mkdirSync(cache, { recursive: true });
    Object.assign(this.env, { TMPDIR: cache, XDG_CACHE_HOME: cache, CUPEL_VITEST_IMPORT: this.importUrl });
    const original = ['vitest.config.mts', 'vitest.config.ts', 'vitest.config.mjs', 'vitest.config.js',
      'vite.config.mts', 'vite.config.ts', 'vite.config.mjs', 'vite.config.js'].find((f) => existsSync(join(root, f)));
    const base = original ? `import original from ${JSON.stringify(pathToFileURL(join(root, original)).href)};` : 'const original = {};';
    this.config = join(tmp, 'vitest.config.mjs');
    writeFileSync(this.config, `${base}\nimport { realpathSync, readFileSync, appendFileSync } from 'node:fs';\n` +
      `import { fileURLToPath } from 'node:url';\n` +
      `const plugin = { name: 'cupel-mutant', enforce: 'pre', load(id) {\n` +
      `  const path = process.env.CUPEL_MUTANT; if (!path) return null;\n` +
      `  const spec = JSON.parse(readFileSync(path, 'utf8'));\n` +
      `  let target = id.split('?')[0].split('#')[0];\n` +
      `  if (target.startsWith('file:')) target = fileURLToPath(target);\n` +
      `  try { if (realpathSync(target) !== spec.realPath) return null; } catch { return null; }\n` +
      `  appendFileSync(spec.seen, 'loaded\\n'); return readFileSync(spec.sourcePath, 'utf8');\n` +
      `} };\n` +
      `export default async (env) => { const base = typeof original === 'function' ? await original(env) : original;\n` +
      `  const test = base.test ?? {}; const setup = test.setupFiles;\n` +
      `  return { ...base, plugins: [...(base.plugins ?? []), plugin], cacheDir: ${JSON.stringify(join(cache, 'vite'))},\n` +
      `    test: { ...test, pool: 'forks', coverage: { ...(test.coverage ?? {}), enabled: false },\n` +
      `      setupFiles: [...(Array.isArray(setup) ? setup : setup ? [setup] : []), ${JSON.stringify(join(here, 'vitest-setup.mjs'))}] } }; };\n`);
  }

  spec(spec) {
    const parsed = JSON.parse(readFileSync(spec.path, 'utf8'));
    writeFileSync(spec.path, JSON.stringify({ ...parsed, realPath: realpathSync(fileURLToPath(parsed.url)) }));
  }

  runTestFile({ file, mutantSpec = null, timeoutMs, stopAt = Infinity }) {
    const n = ++counter;
    const report = join(this.tmp, `vitest-report-${n}.jsonl`);
    const marks = join(this.tmp, `vitest-marks-${n}.txt`);
    const env = { ...this.env, CUPEL_VITEST_MUTATION_REPORT: report, CUPEL_VITEST_MUTATION_MARKS: marks };
    if (mutantSpec) env.CUPEL_MUTANT = mutantSpec;
    return new Promise((resolve) => {
      const started = performance.now();
      const args = [...this.command.slice(1), 'run', '--root', this.root, '--config', this.config,
        '--configLoader', 'runner', '--pool=forks', '--reporter', join(here, 'vitest-reporter.mjs'), file];
      const child = spawn(this.command[0], args, { cwd: this.root, env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '', timedOut = false, cut = false, finished = false;
      child.stderr.setEncoding('utf8').on('data', (d) => { stderr = (stderr + d).slice(-4000); });
      const budget = stopAt - started;
      const byBudget = budget < timeoutMs;
      const timer = setTimeout(() => {
        if (byBudget) cut = true; else timedOut = true;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      }, Math.max(1, Math.round(Math.min(timeoutMs, budget))));
      const finish = (code, signal) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
        const results = existsSync(report) ? readFileSync(report, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
          try { return [JSON.parse(line)]; } catch { return []; }
        }) : [];
        const startedTests = [], endedTests = [];
        if (existsSync(marks)) for (const line of readFileSync(marks, 'utf8').split('\n')) {
          if (line.startsWith('S ')) startedTests.push(line.slice(2));
          else if (line.startsWith('E ')) endedTests.push(line.slice(2));
        }
        resolve({ code, signal, timedOut, cut, wallMs: Math.round(performance.now() - started),
          results, started: startedTests, ended: endedTests, stderr });
      };
      child.on('error', (error) => { stderr += String(error); finish(-1, null); });
      child.on('close', finish);
    });
  }
}
