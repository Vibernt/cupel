import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute, parallel } from './process.mjs';
import { combineRuns, covered, inSourceScope, lineSet } from './coverage.mjs';
import { scanRust } from './lex.mjs';
import { BASE, MARKER, digest } from './runner-shim.mjs';
import { exportLinesFromFile } from './export-stream.mjs';
import { definitions, harnessName } from './tests.mjs';
import { matchesTestFile } from './test-globs.mjs';
import { CargoSourceFacts } from './source-facts.mjs';

const remedy = 'rustup component add llvm-tools-preview';
const windows = process.platform === 'win32';
const exe = (name) => windows ? `${name}.exe` : name;
// Coverage of dependencies and the standard library is never in scope.
const IGNORE = '--ignore-filename-regex=[\\\\/]\\.cargo[\\\\/](registry|git)[\\\\/]|[\\\\/]rustc[\\\\/]';
const SELECTION = ['--lib', '--bin', '--bins', '--example', '--examples', '--test', '--tests', '--bench', '--benches', '--all-targets', '--doc'];
export const UNMEASURED = 'not compiled into any test binary or workspace program built for this host';

/** True when the user's cargo arguments already choose targets. */
export function selectsTargets(args) {
  return args.some((arg) => SELECTION.includes(arg) || SELECTION.some((flag) => arg.startsWith(`${flag}=`)));
}

/** Environment keys are case-insensitive on Windows: an added key replaces every spelling. */
export function withVariables(env, added = {}, removed = [], platform = process.platform) {
  const out = { ...env };
  const same = (a, b) => platform === 'win32' ? a.toUpperCase() === b.toUpperCase() : a === b;
  for (const name of [...Object.keys(added), ...removed]) for (const key of Object.keys(out)) if (same(key, name)) delete out[key];
  return Object.assign(out, added);
}

const binaryKey = (path) => windows ? resolve(path).toLowerCase() : resolve(path);

/** Runner records from the capture run's stderr, keyed by resolved binary path. */
export function runnerRecords(stderr) {
  const records = new Map();
  for (const line of stderr.split('\n')) {
    const at = line.indexOf(MARKER);
    if (at < 0) continue;
    const record = JSON.parse(Buffer.from(line.slice(at + MARKER.length).trim(), 'base64').toString('utf8'));
    records.set(binaryKey(record.binary), record);
  }
  return records;
}

/** Workspace programs (bin targets) built for the tests, which tests may start. */
export function programs(output) {
  return output.split('\n').filter(Boolean).flatMap((line) => {
    const message = JSON.parse(line);
    return message.reason === 'compiler-artifact' && message.profile?.test === false && message.executable
      && message.target?.kind?.includes('bin') ? [message.executable] : [];
  });
}

/** A file defines at least one function with a body (`fn name ... {`). */
export function definesFunctions(source) {
  const tokens = scanRust(source).tokens;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].value !== 'fn' || !/^[A-Za-z_]/.test(tokens[i + 1].value)) continue;
    for (let j = i + 2; j < tokens.length; j++) {
      if (tokens[j].value === ';') break;
      if (tokens[j].value === '{') return true;
    }
  }
  return false;
}
export function targetEnvironment(root, environment) {
  if (!environment.CARGO_TARGET_DIR) return {};
  // Cargo can reuse instrumented binaries from another checkout when both share
  // one target directory. Keep the user's cache volume, but isolate each root.
  const key = createHash('sha256').update(root).digest('hex').slice(0, 16);
  return { CARGO_TARGET_DIR: join(environment.CARGO_TARGET_DIR, 'cupel', key) };
}

export function artifacts(output) {
  return output.split('\n').filter(Boolean).flatMap((line) => {
    let message;
    try { message = JSON.parse(line); } catch { throw new Error(`invalid cargo JSON message: ${line}`); }
    return message.reason === 'compiler-artifact' && message.profile?.test === true && message.executable
      ? [{ binary: message.executable, root: message.target?.src_path, manifest: message.manifest_path, name: message.target?.name }] : [];
  });
}

export function listedTests(output) {
  return output.split('\n').flatMap((line) => {
    const match = /^(.*): test\s*$/.exec(line.trim());
    return match ? [match[1]] : [];
  });
}

export function testResult(output, name, status) {
  const lines = output.split('\n').map((item) => item.replace(/\r$/, ''));
  const line = lines.find((item) => item.startsWith(`test ${name} ... `) || item.startsWith(`test ${name} - should panic ... `));
  // A test that aborts the process (abort, segfault, stack overflow) leaves no harness line: it failed.
  if (!line) {
    if (status !== 0) return 'failed';
    throw new Error(`Rust test ${name} exited without a harness result (exit ${status}): ${output.trim()}`);
  }
  if (line.includes(' ... ignored')) return 'skipped';
  if (line.includes(' ... FAILED')) return 'failed';
  if (line.includes(' ... ok') && status === 0) return 'passed';
  throw new Error(`Rust test ${name} has inconsistent harness result (exit ${status}): ${line}`);
}

export async function llvmTools(root, env, rustInfo) {
  const host = /^host: (.+)$/m.exec(rustInfo)?.[1];
  const major = /^LLVM version: (\d+)/m.exec(rustInfo)?.[1];
  if (!host || !major) throw new Error('could not read rustc host and LLVM version');
  const sysroot = (await execute('rustc', ['--print', 'sysroot'], { root, env })).stdout.trim();
  const component = join(sysroot, 'lib', 'rustlib', host, 'bin');
  const path = env.PATH ?? env.Path ?? '';
  const dirs = [component, ...path.split(delimiter).filter(Boolean)];
  for (const dir of dirs) {
    const profdata = join(dir, exe('llvm-profdata')); const cov = join(dir, exe('llvm-cov'));
    if (!existsSync(profdata) || !existsSync(cov)) continue;
    const versions = await Promise.all([profdata, cov].map((tool) => execute(tool, ['--version'], { root, env, allowFailure: true })));
    if (versions.every((result) => result.status === 0 && new RegExp(`\\bversion ${major}(?:\\.|\\b)`).test(result.stdout))) return { profdata, cov };
  }
  throw new Error(remedy);
}

async function profileFor({ binary, name, run, index, scratch, root, cwd, runEnv: base, objects, tools }) {
  const prefix = `test-${index}-${run}-`;
  const runEnv = { ...base, LLVM_PROFILE_FILE: join(scratch, `${prefix}%p.profraw`) };
  const result = await execute(binary, ['--exact', name, '--test-threads=1'], { root: cwd, env: runEnv, allowFailure: true });
  const status = testResult(result.stdout + result.stderr, name, result.status);
  const raw = readdirSync(scratch).filter((file) => file.startsWith(prefix) && file.endsWith('.profraw')).map((file) => join(scratch, file));
  if (!raw.length) {
    // An aborted process never writes its profile; the failed test simply has no coverage.
    if (status === 'failed') return { status, duration: result.duration, coverage: covered(new Map()), files: new Map() };
    throw new Error(`Rust test ${name} produced no LLVM profile`);
  }
  const files = await exported({ raw, name: `test-${index}-${run}`, objects: [binary, ...objects], scratch, root, cwd, env: base, tools });
  return { status, duration: result.duration, coverage: covered(files), files };
}

// Merge raw profiles and export line data for the given objects. The first
// object is the main one; the rest (workspace programs a test may start) are
// passed with -object, so coverage from child processes counts.
async function exported({ raw, name, objects, scratch, root, cwd, env, tools }) {
  const profdata = join(scratch, `${name}.profdata`);
  await execute(tools.profdata, ['merge', '-sparse', ...raw, '-o', profdata], { root: cwd, env });
  const exportPath = join(scratch, `${name}.json`);
  const [main, ...rest] = objects;
  await execute(tools.cov, ['export', '-format=text', `-instr-profile=${profdata}`, main, ...rest.flatMap((object) => ['-object', object]), IGNORE],
    { root: cwd, env, stdoutPath: exportPath });
  const files = await exportLinesFromFile(exportPath, root);
  for (const path of [...raw, profdata, exportPath]) rmSync(path);
  return files;
}

export async function collectCargo({ root, runs = 2, recheck = [], tests: testGlob, args = [], environment = process.env }) {
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('--runs must be a positive safe integer');
  if (args.some((arg) => ['--no-run', '--message-format', '--offline', '--online', '--'].includes(arg) || arg.startsWith('--message-format='))) {
    throw new Error('cargo test arguments may not override collector build or offline options');
  }
  const sourceFacts = new CargoSourceFacts(root);
  const env = { ...environment, ...targetEnvironment(root, environment), CARGO_NET_OFFLINE: 'true', RUSTFLAGS: [environment.RUSTFLAGS, '-C instrument-coverage'].filter(Boolean).join(' ') };
  const rustInfo = (await execute('rustc', ['-vV'], { root, env })).stdout;
  const version = /^release: (.+)$/m.exec(rustInfo)?.[1];
  if (!version) throw new Error('could not read exact Rust version');
  const tools = await llvmTools(root, env, rustInfo);
  const host = /^host: (.+)$/m.exec(rustInfo)[1];
  const sourceDefs = definitions(root, sourceFacts.bytes);
  let packageArgs = [];
  if (testGlob) {
    const selected = sourceDefs.filter((item) => matchesTestFile(testGlob, item.file));
    if (!selected.length) throw new Error(`no Rust test files match ${testGlob}`);
    const metadata = JSON.parse((await execute('cargo', ['metadata', '--offline', '--format-version=1', '--no-deps'], { root, env })).stdout);
    const packages = metadata.packages.map((pkg) => ({ name: pkg.name, dir: relative(root, dirname(pkg.manifest_path)).split(sep).join('/') }));
    const names = new Set();
    for (const test of selected) {
      const owner = packages.filter((pkg) => !pkg.dir || pkg.dir === '.' || test.file.startsWith(`${pkg.dir}/`))
        .sort((a, b) => b.dir.length - a.dir.length)[0];
      if (!owner) throw new Error(`Rust test file has no Cargo package: ${test.file}`);
      names.add(owner.name);
    }
    packageArgs = [...names].sort().flatMap((name) => ['-p', name]);
  }
  // Without a target choice, `--tests` builds and runs what `cargo test` runs, minus doctests.
  const cargoArgs = [...packageArgs, ...(selectsTargets(args) ? [] : ['--tests']), ...args];
  const scratchRoot = join(root, '.scratch');
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, 'cupel-cargo-'));
  const tests = []; const byTest = {}; const shapes = {}; const brittleness = [];
  const sources = new Map(); const unstable = new Map();
  try {
    // Instrumented build scripts and proc macros write profiles too: keep them
    // in scratch, never in the project.
    const buildEnv = { ...env, LLVM_PROFILE_FILE: join(scratch, 'build-%p-%m.profraw') };
    const build = await execute('cargo', ['test', '--offline', '--no-run', '--message-format=json', ...cargoArgs], { root, env: buildEnv });
    const binaries = artifacts(build.stdout);
    const objects = [...new Set(programs(build.stdout))].sort();
    if (!binaries.length) throw new Error('cargo test produced no test executables');
    // Run every test binary once through Cargo with a recording runner, so each
    // test later runs in the directory and environment Cargo gives it.
    const listEnv = { ...env, LLVM_PROFILE_FILE: join(scratch, 'list-%p.profraw') };
    const base = Object.fromEntries(Object.entries(listEnv).map(([name, value]) => [name, digest(value)]));
    const shim = fileURLToPath(new URL('./runner-shim.mjs', import.meta.url));
    const runner = `target.${JSON.stringify(host)}.runner=${JSON.stringify([process.execPath, shim])}`;
    const capture = await execute('cargo', ['test', '--offline', '--config', runner, '--no-fail-fast', ...cargoArgs, '--', '--list', '--format', 'terse'],
      { root, env: { ...listEnv, [BASE]: JSON.stringify(base) }, allowFailure: true });
    const records = runnerRecords(capture.stderr);
    const jobs = [];
    for (const artifact of binaries) {
      const record = records.get(binaryKey(artifact.binary));
      if (!record) throw new Error(`cargo test did not run ${artifact.binary} through the collector's runner (exit ${capture.status}): ${capture.stderr.split('\n').filter((line) => !line.includes(MARKER)).join('\n').trim()}`);
      const runEnv = withVariables(listEnv, record.added, record.removed);
      const names = listedTests((await execute(artifact.binary, ['--list', '--format', 'terse'], { root: record.cwd, env: runEnv })).stdout);
      const crateDir = artifact.manifest ? relative(root, dirname(artifact.manifest)).split(sep).join('/') : '';
      for (const name of names) {
        const inCrate = sourceDefs.filter((item) => !crateDir || item.file.startsWith(`${crateDir}/`) || crateDir === '.');
        const candidates = inCrate.filter((item) => harnessName(item, root, artifact.root) === name);
        const cratePath = artifact.root ? relative(root, artifact.root).split(sep).join('/') : null;
        if (candidates.length > 1) throw new Error(`ambiguous Rust test definition: ${name}`);
        const def = candidates[0];
        const file = def?.file ?? (cratePath ?? `${basename(artifact.binary)}.rs`);
        if (testGlob && !matchesTestFile(testGlob, file)) continue;
        const id = `${file}::${name.split('::').join(' > ')}`;
        jobs.push({ binary: artifact.binary, name, id, file, def, cwd: record.cwd, runEnv });
      }
    }
    if (!jobs.length) throw new Error(testGlob ? `no Rust test files match ${testGlob}` : 'cargo test listed no tests');
    const ids = new Set(jobs.map((job) => job.id));
    if (ids.size !== jobs.length) throw new Error('duplicate Rust test ids across test binaries');
    for (const id of recheck) if (!ids.has(id)) throw new Error(`unknown Rust recheck unit: ${id}`);
    // Parallelize distinct tests, but run each test's repeats in order. This
    // preserves K13's temporal comparison and avoids racing stateful tests.
    const outputs = await parallel(jobs, async (job, index) => {
      const records = [];
      for (let run = 0; run < runs; run++) {
        const record = await profileFor({ ...job, index, run, scratch, root, objects, tools });
        for (const [path, lines] of record.files) {
          if (!sources.has(path)) sources.set(path, new Set());
          for (const line of lines.all) sources.get(path).add(line);
        }
        records.push({ status: record.status, duration: record.duration, coverage: record.coverage });
      }
      return records;
    }, 2);
    for (let index = 0; index < jobs.length; index++) {
      const job = jobs[index]; const records = outputs[index];
      tests.push({ id: job.id, file: job.file, name: job.name, ...(job.def?.tags ? { tags: job.def.tags } : {}),
        status: records.some((record) => record.status === 'failed') ? 'failed' : records.every((record) => record.status === 'skipped') ? 'skipped' : 'passed',
        durationsMs: records.map((record) => record.duration) });
      byTest[job.id] = combineRuns(records.map((record) => record.coverage), unstable);
      if (job.def) { shapes[job.id] = job.def.shape; brittleness.push(...job.def.brittleness.map((finding) => ({ ...finding, test: job.id }))); }
    }
    // Coverable lines come from every instrumented test binary and workspace
    // program, so code that no test reaches (or that only a started program
    // contains) still counts in the denominator.
    const raw = readdirSync(scratch).filter((file) => file.startsWith('list-') && file.endsWith('.profraw')).map((file) => join(scratch, file));
    if (!raw.length) throw new Error('Rust test binaries produced no LLVM profile while listing');
    const universe = await exported({ raw, name: 'universe', objects: [...binaries.map((artifact) => artifact.binary), ...objects], scratch, root, cwd: root, env, tools });
    for (const [path, lines] of universe) {
      if (!sources.has(path)) sources.set(path, new Set());
      for (const line of lines.all) sources.get(path).add(line);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  sourceFacts.assertFresh();
  // Bind every inventoried source, including module-only/test-only files for
  // which LLVM emitted no executable regions. Empty sets invent no coverage.
  // An in-scope file that defines functions but appears in no instrumented
  // object was not measured on this host: it is labelled, never shown as 0%.
  const unmeasured = new Set();
  for (const file of sourceFacts.files) {
    if (sources.has(file)) continue;
    sources.set(file, new Set());
    if (inSourceScope(file) && definesFunctions(sourceFacts.bytes.get(file).toString('utf8'))) unmeasured.add(file);
  }
  tests.sort((a, b) => a.id.localeCompare(b.id));
  return { spec: 'cupel-spec/1', kind: 'input', runtime: { name: 'rust', version },
    sources: Object.fromEntries([...sources].sort(([a], [b]) => a.localeCompare(b)).map(([path, lines]) => [path, {
      coverable: lineSet(lines), hash: sourceFacts.sourceHash(path), ...(unmeasured.has(path) ? { unmeasured: UNMEASURED } : {}) }])),
    tests, coverage: { granularity: 'test', byTest, setup: {}, ...(runs > 1 ? { unstable: Object.fromEntries([...unstable].sort(([a], [b]) => a.localeCompare(b)).map(([path, lines]) => [path, lineSet(lines)])) } : {}), rechecked: tests.map((test) => test.id) },
    brittleness, shapes };
}
