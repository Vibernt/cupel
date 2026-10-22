import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { globMatches } from '../../engine/match.mjs';
import { formatLines, unionLines } from '../node/lines.mjs';
import { analyseTestFile, patternFindings } from '../node/testfile.mjs';
import { VitestCollectorError } from './errors.mjs';
import { posix, scanSources, sourceMapLines, TEST, walk } from './sources.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sort = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const object = (entries) => Object.fromEntries([...entries].sort((a, b) => sort(a[0], b[0])));
export { VitestCollectorError } from './errors.mjs';

function resolveVitest(root) {
  const require = createRequire(join(root, 'package.json'));
  let pkg;
  try { pkg = require.resolve('vitest/package.json'); }
  catch { throw new VitestCollectorError(`vitest is not resolvable from ${root}`); }
  const version = JSON.parse(readFileSync(pkg, 'utf8')).version;
  const major = Number(version.split('.')[0]);
  if (![3, 4, 5].includes(major)) throw new VitestCollectorError(`unsupported Vitest ${version}; expected 3, 4 or 5`);
  return { entry: join(dirname(pkg), 'vitest.mjs'), importUrl: pathToFileURL(join(dirname(pkg), 'dist/index.js')).href, version };
}

function run(command, args, options) {
  return new Promise((done, fail) => {
    const start = performance.now();
    let tail = '';
    const child = spawn(command[0], [...command.slice(1), ...args], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { tail = (tail + data).slice(-5000); });
    child.on('error', fail);
    child.on('close', (code, signal) => done({ code, signal, ms: performance.now() - start, tail }));
  });
}

function splitCommand(value) {
  const words = [];
  let word = '', quote = null, escaped = false, started = false;
  for (const char of value) {
    if (escaped) { word += char; escaped = false; started = true; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { words.push(word); word = ''; started = false; } }
    else { word += char; started = true; }
  }
  if (quote || escaped) throw new VitestCollectorError('runners.vitest.command has an unmatched quote or escape');
  if (started) words.push(word);
  return words;
}

export async function collectVitest({ root, config = {}, files, runs = 2, recheck = [], log = () => {} } = {}) {
  if (!root) throw new VitestCollectorError('collectVitest: root is required');
  root = realpathSync(resolve(root));
  const vitest = resolveVitest(root);
  const runner = config.runners?.vitest ?? {};
  const command = runner.command ? splitCommand(runner.command) : [process.execPath, vitest.entry];
  if (!command[0]) throw new VitestCollectorError('runners.vitest.command is empty');
  const fileNames = files?.length ? files.map((f) => posix(relative(root, resolve(root, f)))) :
    walk(root, true).filter((f) => runner.tests ? globMatches(runner.tests, f) : TEST.test(f));
  if (!fileNames.length) throw new VitestCollectorError('no Vitest test files found');
  for (const file of fileNames) {
    if (file === '..' || file.startsWith('../')) throw new VitestCollectorError(`test file is outside project root: ${file}`);
    if (!existsSync(join(root, file))) throw new VitestCollectorError(`test file not found: ${file}`);
    const real = posix(relative(root, realpathSync(join(root, file))));
    if (real === '..' || real.startsWith('../')) throw new VitestCollectorError(`test file resolves outside project root: ${file}`);
  }
  const sources = scanSources(root, config.scope);
  mkdirSync(join(root, '.scratch'), { recursive: true });
  const work = mkdtempSync(join(root, '.scratch/cupel-vitest-'));
  const mappingFailed = new Set();
  try {
    const original = ['vitest.config.mts', 'vitest.config.ts', 'vitest.config.mjs', 'vitest.config.js', 'vite.config.mts', 'vite.config.ts', 'vite.config.mjs', 'vite.config.js'].find((f) => existsSync(join(root, f)));
    const configFile = join(work, 'config.mjs');
    const importOriginal = original ? `import original from ${JSON.stringify(pathToFileURL(join(root, original)).href)};` : 'const original = {};';
    const include = files?.length ? fileNames : runner.tests ? [runner.tests] : null;
    writeFileSync(configFile, `${importOriginal}\nexport default async (env) => { const base = typeof original === 'function' ? await original(env) : original; const { cache: ignoredCache, ...test } = base.test ?? {}; const setup = test.setupFiles; return { ...base, cacheDir: ${JSON.stringify(join(work, 'vite-cache'))}, test: { ...test, ${include ? `include: ${JSON.stringify(include)},` : ''} pool: 'forks', includeTaskLocation: true, setupFiles: [...(Array.isArray(setup) ? setup : setup ? [setup] : []), ${JSON.stringify(join(here, 'setup.mjs'))}], coverage: { ...(test.coverage ?? {}), enabled: false } } }; };\n`);
    const execute = async (label, selected = fileNames, pattern = null) => {
      const out = join(work, label);
      mkdirSync(out);
      const resultFile = join(out, 'results.json');
      const hook = JSON.stringify({ root, out });
      const args = ['run', '--root', root, '--config', configFile, '--configLoader', 'runner', '--pool=forks', '--reporter', join(here, 'reporter.mjs'), '--includeTaskLocation', ...selected];
      if (pattern) args.push('-t', pattern);
      const r = await run(command, args, { cwd: root, env: { ...process.env, ...(runner.env ?? {}), CUPEL_VITEST_HOOK: hook, CUPEL_VITEST_IMPORT: vitest.importUrl, CUPEL_VITEST_RESULTS: resultFile } });
      if (!existsSync(resultFile)) throw new VitestCollectorError(`vitest ${vitest.version} did not report (${r.signal ?? r.code}): ${r.tail.trim()}`);
      const results = JSON.parse(readFileSync(resultFile, 'utf8'));
      if (results.errors?.length) throw new VitestCollectorError(`vitest ${vitest.version} had an unhandled error: ${JSON.stringify(results.errors[0])}`);
      const hookFiles = readdirSync(out).filter((f) => /\.json$/.test(f) && f !== 'results.json');
      const hookData = hookFiles.map((f) => JSON.parse(readFileSync(join(out, f), 'utf8')));
      if (results.tests.some((t) => t.status !== 'skipped') && !hookData.length) throw new VitestCollectorError(`Vitest hook did not write coverage (exit ${r.code}, files ${hookFiles.join(',')}, tests ${JSON.stringify(results.tests)}): ${r.tail.trim()}`);
      const coverage = new Map(), setup = new Map(), spawns = new Set();
      const convert = (data, into, scriptMap) => {
        for (const [id, intervals] of Object.entries(data)) {
          const script = scriptMap[id];
          if (!script) continue;
          const got = sourceMapLines(root, script, intervals, sources, log);
          if (got?.[1] === null) { mappingFailed.add(got[0]); continue; }
          if (!got?.[1].length) continue;
          const [file, lines] = got;
          into.set(file, unionLines(into.get(file) ?? [], lines));
        }
      };
      for (const h of hookData) {
        for (const error of h.failures ?? []) log(`inspector: ${error}`);
        if (h.file) {
          const file = posix(relative(root, h.file));
          if (!setup.has(file)) setup.set(file, new Map());
          convert(h.setup, setup.get(file), h.scripts);
        }
        for (const [id, data] of Object.entries(h.tests)) {
          if (!coverage.has(id)) coverage.set(id, new Map());
          convert(data.coverage, coverage.get(id), h.scripts);
          if (data.spawnsInterpreter) spawns.add(id);
        }
      }
      log(`Vitest ${vitest.version}: ${results.tests.length} tests in ${Math.round(r.ms)} ms`);
      return { ...results, coverage, setup, spawns, ms: r.ms };
    };
    const repeats = [];
    for (let i = 0; i < Math.max(1, runs); i++) repeats.push(await execute(`run${i}`));
    const first = repeats[0];
    const tests = new Map();
    const names = new Map();
    for (const t of first.tests) {
      const file = posix(relative(root, t.file));
      const key = `${file}::${t.name}`;
      const n = (names.get(key) ?? 0) + 1;
      names.set(key, n);
      const id = `${key}${n > 1 ? ` #${n}` : ''}`;
      tests.set(t.taskId, { ...t, id, file, durationsMs: [] });
    }
    for (const repeat of repeats) for (const t of repeat.tests) {
      const record = tests.get(t.taskId);
      if (record) { record.durationsMs.push(Math.max(0, Math.round(t.duration))); if (t.status === 'failed') record.status = 'failed'; }
    }
    const groups = new Map();
    for (const t of tests.values()) {
      if (!t.line) continue;
      const key = `${t.file}:${t.line}:${t.column}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const occupiedUnits = new Set();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const first = group[0];
      let unit = `${first.file}::@${first.line}`;
      if (occupiedUnits.has(unit)) unit += `:${first.column}`;
      occupiedUnits.add(unit);
      for (const t of group) t.unit = unit;
    }
    const rechecked = [];
    for (const unit of recheck) {
      const rows = [...tests.values()].filter((t) => (t.unit ?? t.id) === unit && t.status !== 'skipped');
      if (!rows.length) continue;
      const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = `^(?:${rows.map((t) => t.name.split(' > ').map(escape).join('(?:\\s*>\\s*|\\s+)')).join('|')})$`;
      const checked = await execute(`recheck${rechecked.length}`, [rows[0].file], pattern);
      if (rows.some((t) => !checked.tests.some((u) => u.taskId === t.taskId && u.status === t.status && checked.coverage.has(u.taskId)))) {
        log(`recheck skipped ${unit}: selected rows did not match (${JSON.stringify(checked.tests.map((t) => [t.taskId, t.name, t.status, checked.coverage.has(t.taskId)]))})`); continue;
      }
      for (const t of rows) first.coverage.set(t.taskId, checked.coverage.get(t.taskId));
      rechecked.push(unit);
    }
    const lineObject = (lines) => object([...lines].filter(([file]) => !mappingFailed.has(file)).map(([file, values]) => [file, formatLines(values)]));
    const shapes = new Map(), brittleness = [];
    const patterns = (config.brittleness?.patterns ?? []).filter((p) => !p.language || /^(?:ts|typescript|js|javascript)$/i.test(p.language)).map((p) => ({ kind: p.kind, re: new RegExp(p.pattern, 'm'), deliberate: p.deliberate }));
    for (const file of new Set([...tests.values()].map((t) => t.file))) {
      const text = readFileSync(join(root, file), 'utf8');
      let stripped;
      try { stripped = /\.[cm]?ts$|\.tsx$/.test(file) ? stripTypeScriptTypes(text) : text; }
      catch (e) { throw new VitestCollectorError(`cannot strip test file ${file}: ${e.message}`); }
      let definitions;
      try { definitions = analyseTestFile(stripped); }
      catch (e) { throw new VitestCollectorError(`shared lexer cannot analyse test file ${file}: ${e.message}`); }
      for (const t of tests.values()) {
        if (t.file !== file) continue;
        const def = definitions.filter((d) => d.line === t.line && d.column <= (t.column ?? Infinity)).at(-1);
        if (!def) continue;
        shapes.set(t.unit ?? t.id, def.shape);
        for (const finding of [...def.flags, ...patternFindings(stripped, def, patterns)]) brittleness.push({ test: t.id, kind: finding.kind, line: finding.line, ...(finding.deliberate ? { deliberate: true } : {}) });
      }
    }
    const ordered = [...tests.values()].sort((a, b) => sort(a.id, b.id));
    return {
      spec: 'cupel-spec/1', kind: 'input', runtime: { name: 'node', version: process.versions.node },
      sources: object([...sources].filter(([file]) => !mappingFailed.has(file)).map(([file, source]) => [file, { coverable: formatLines(source.an.coverable), hash: source.hash }])),
      tests: ordered.map((t) => {
        const tags = [...new Set([...t.name.matchAll(/\[(critical|standard|minor)\]/g)].map((m) => m[1]))].sort(sort);
        return { id: t.id, file: t.file, name: t.name, ...(t.unit ? { unit: t.unit } : {}), ...(tags.length ? { tags } : {}), status: t.status, durationsMs: t.durationsMs, ...(first.spawns.has(t.taskId) ? { spawnsInterpreter: true } : {}) };
      }),
      coverage: { granularity: 'test', byTest: object(ordered.filter((t) => first.coverage.has(t.taskId)).map((t) => [t.id, lineObject(first.coverage.get(t.taskId))])), setup: object([...new Set(ordered.map((t) => t.file))].map((file) => [file, lineObject(first.setup.get(file) ?? new Map())])), ...(rechecked.length ? { rechecked: rechecked.sort(sort) } : {}) },
      brittleness: brittleness.sort((a, b) => sort(a.test, b.test) || sort(a.kind, b.kind) || a.line - b.line),
      shapes: object(shapes),
    };
  } finally { rmSync(work, { recursive: true, force: true }); }
}
