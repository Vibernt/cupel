import { availableParallelism } from 'node:os';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execute, goEnvironment, jsonObjects, parallel } from './process.mjs';
import { covered, lineSet, profile, subtract, combineRuns } from './coverage.mjs';
import { definitions } from './tests.mjs';
import { matchesGoTestFile } from './test-globs.mjs';

const topLevel = (name) => /^Test[A-Z0-9_]/.test(name);
const anchored = (name) => `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

function result(output, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = [...output.matchAll(new RegExp(`^\\s*--- (PASS|FAIL|SKIP): ${escaped} \\(([0-9.]+)s\\)`, 'gm'))];
  const last = lines.at(-1);
  if (!last) throw new Error(`Go test ${name} exited without a top-level result: ${output.trim()}`);
  return { status: { PASS: 'passed', FAIL: 'failed', SKIP: 'skipped' }[last[1]], duration: Math.round(Number(last[2]) * 1000) };
}

export async function collectGo({ root, runs = 2, recheck = [], packages: patterns = ['./...'], tests: testGlob, note = () => {} }) {
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
  if (!patterns.length || patterns.some((p) => p.startsWith('-'))) throw new Error('Go package arguments must be non-option package patterns');
  const env = goEnvironment(root);
  const version = (await execute('go', ['version'], { root, env })).stdout.trim().match(/go([0-9][^ ]*)/)?.[1];
  if (!version) throw new Error('could not read exact Go version');
  const packages = jsonObjects((await execute('go', ['list', '-json', ...patterns], { root, env })).stdout);
  if (!packages.length) throw new Error('go list returned no packages');
  const modulePackages = jsonObjects((await execute('go', ['list', '-json', './...'], { root, env })).stdout);
  if (!modulePackages.length) throw new Error('go list returned no module packages');
  const coverpkg = modulePackages.map((p) => p.ImportPath).join(',');
  const cache = new Map();
  const scratch = mkdtempSync(join(env.TMPDIR, 'cupel-go-'));
  const sources = {};
  const tests = [];
  const byTest = {};
  const setupByFile = {};
  const shapes = {};
  const brittleness = [];
  const unstable = new Map();
  try {
    const allFile = join(scratch, 'all-packages.cover');
    await execute('go', ['test', '-covermode=count', `-coverpkg=${coverpkg}`, '-coverprofile', allFile, './...'], { root, env, allowFailure: true });
    for (const [path, lines] of profile(allFile, modulePackages, root, cache)) sources[path] = lines.all;
    for (const [pi, pkg] of packages.entries()) {
      if (!(pkg.TestGoFiles?.length || pkg.XTestGoFiles?.length)) continue;
      const defs = definitions(pkg, root);
      const binary = join(scratch, `package-${pi}.test`);
      await execute('go', ['test', '-c', '-covermode=count', `-coverpkg=${coverpkg}`, '-o', binary, pkg.ImportPath], { root, env });
      const listed = (await execute(binary, ['-test.list', '.*'], { root, env })).stdout.split('\n').filter(topLevel)
        .filter((name) => !testGlob || (defs.has(name) && matchesGoTestFile(testGlob, defs.get(name).file)));
      for (const name of listed) if (!defs.has(name)) throw new Error(`listed Go test ${name} has no source definition in ${pkg.ImportPath}`);
      const setupRuns = [];
      for (let r = 0; r < runs; r++) {
        const setupFile = join(scratch, `setup-${pi}-${r}.cover`);
        await execute(binary, ['-test.run', '^$', '-test.coverprofile', setupFile], { root, env });
        setupRuns.push(profile(setupFile, modulePackages, root, cache));
      }
      for (const file of new Set(listed.map((name) => defs.get(name).file))) setupByFile[file] = combineRuns(setupRuns.map(covered), unstable);
      const taskList = listed.flatMap((name) => Array.from({ length: runs }, (_, r) => ({ name, r })));
      const outputs = await parallel(taskList, Math.max(1, Math.floor(availableParallelism() / 2)), async ({ name, r }, ti) => {
        const file = join(scratch, `test-${pi}-${ti}.cover`);
        const run = await execute(binary, ['-test.run', anchored(name), '-test.coverprofile', file, '-test.v'], { root, env, allowFailure: true });
        const actual = result(run.stdout, name);
        const subtests = [...run.stdout.matchAll(/^=== RUN\s+([^\n]+)$/gm)].map((match) => match[1]).filter((subtest) => subtest.startsWith(`${name}/`));
        return { name, r, ...actual, subtests, coverage: subtract(profile(file, modulePackages, root, cache), setupRuns[r]) };
      });
      for (const name of listed) {
        const def = defs.get(name);
        const runsForTest = outputs.filter((item) => item.name === name);
        const subtests = [...new Set(runsForTest.flatMap((item) => item.subtests))].sort((a, b) => (a > b) - (a < b));
        if (subtests.length) note(`${def.id}: subtests ${subtests.join(', ')}`);
        tests.push({ id: def.id, file: def.file, name, ...(def.tags ? { tags: def.tags } : {}), status: runsForTest.some((r) => r.status === 'failed') ? 'failed' : runsForTest.every((r) => r.status === 'skipped') ? 'skipped' : 'passed', durationsMs: runsForTest.map((r) => r.duration), ...(def.spawnsInterpreter ? { spawnsInterpreter: true } : {}) });
        byTest[def.id] = combineRuns(runsForTest.map((item) => item.coverage), unstable);
        shapes[def.id] = def.shape;
        brittleness.push(...def.brittleness);
      }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  tests.sort((a, b) => (a.id > b.id) - (a.id < b.id));
  if (testGlob && !tests.length) throw new Error(`no Go test files match ${testGlob}`);
  const ids = new Set(tests.map((t) => t.id));
  for (const id of recheck) if (!ids.has(id)) throw new Error(`unknown Go recheck unit: ${id}`);
  return {
    spec: 'cupel-spec/1', kind: 'input', runtime: { name: 'go', version },
    sources: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => (a > b) - (a < b)).map(([path, lines]) => [path, {
      coverable: lineSet(lines), hash: `sha256:${createHash('sha256').update(readFileSync(join(root, path))).digest('hex')}`,
    }])),
    tests, coverage: { granularity: 'test', byTest, setup: setupByFile, ...(runs > 1 ? { unstable: Object.fromEntries([...unstable].sort(([a], [b]) => (a > b) - (a < b)).map(([source, lines]) => [source, lineSet(lines)])) } : {}), rechecked: tests.map((t) => t.id) },
    brittleness, shapes,
  };
}
