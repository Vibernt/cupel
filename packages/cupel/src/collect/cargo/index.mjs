import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, delimiter, dirname, join, relative, sep } from 'node:path';
import { execute, parallel } from './process.mjs';
import { combineRuns, covered, exportLines, lineSet } from './coverage.mjs';
import { definitions, harnessName } from './tests.mjs';
import { matchesTestFile } from './test-globs.mjs';

const remedy = 'rustup component add llvm-tools-preview';

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
  const line = output.split('\n').find((item) => item.startsWith(`test ${name} ... `));
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
  const dirs = [component, ...env.PATH.split(delimiter), '/opt/homebrew/opt/llvm/bin'];
  for (const dir of dirs) {
    const profdata = join(dir, 'llvm-profdata'); const cov = join(dir, 'llvm-cov');
    if (!existsSync(profdata) || !existsSync(cov)) continue;
    const versions = await Promise.all([profdata, cov].map((tool) => execute(tool, ['--version'], { root, env, allowFailure: true })));
    if (versions.every((result) => result.status === 0 && new RegExp(`\\bversion ${major}(?:\\.|\\b)`).test(result.stdout))) return { profdata, cov };
  }
  throw new Error(remedy);
}

async function profileFor({ binary, name, run, index, scratch, root, env, tools }) {
  const prefix = `test-${index}-${run}-`;
  const runEnv = { ...env, LLVM_PROFILE_FILE: join(scratch, `${prefix}%p.profraw`) };
  const result = await execute(binary, ['--exact', name, '--test-threads=1'], { root, env: runEnv, allowFailure: true });
  const status = testResult(result.stdout + result.stderr, name, result.status);
  const raw = readdirSync(scratch).filter((file) => file.startsWith(prefix) && file.endsWith('.profraw')).map((file) => join(scratch, file));
  if (!raw.length) {
    // An aborted process never writes its profile; the failed test simply has no coverage.
    if (status === 'failed') return { status, duration: result.duration, coverage: covered(new Map()), files: new Map() };
    throw new Error(`Rust test ${name} produced no LLVM profile`);
  }
  const profdata = join(scratch, `test-${index}-${run}.profdata`);
  await execute(tools.profdata, ['merge', '-sparse', ...raw, '-o', profdata], { root, env });
  const exported = await execute(tools.cov, ['export', '-format=text', `-instr-profile=${profdata}`, binary, '--ignore-filename-regex=/.cargo/registry|/rustc/'], { root, env });
  const files = exportLines(JSON.parse(exported.stdout), root);
  return { status, duration: result.duration, coverage: covered(files), files };
}

export async function collectCargo({ root, runs = 2, recheck = [], tests: testGlob, args = [], environment = process.env }) {
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('--runs must be a positive safe integer');
  if (args.some((arg) => ['--no-run', '--message-format', '--offline', '--online', '--'].includes(arg) || arg.startsWith('--message-format='))) {
    throw new Error('cargo test arguments may not override collector build or offline options');
  }
  const env = { ...environment, ...targetEnvironment(root, environment), CARGO_NET_OFFLINE: 'true', RUSTFLAGS: [environment.RUSTFLAGS, '-C instrument-coverage'].filter(Boolean).join(' ') };
  const rustInfo = (await execute('rustc', ['-vV'], { root, env })).stdout;
  const version = /^release: (.+)$/m.exec(rustInfo)?.[1];
  if (!version) throw new Error('could not read exact Rust version');
  const tools = await llvmTools(root, env, rustInfo);
  const sourceDefs = definitions(root);
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
  const build = await execute('cargo', ['test', '--offline', '--no-run', '--message-format=json', ...packageArgs, ...args], { root, env });
  const binaries = artifacts(build.stdout);
  if (!binaries.length) throw new Error('cargo test produced no test executables');
  const scratchRoot = join(root, '.scratch');
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, 'cupel-cargo-'));
  const tests = []; const byTest = {}; const shapes = {}; const brittleness = [];
  const sources = new Map(); const unstable = new Map();
  try {
    const jobs = [];
    for (const artifact of binaries) {
      const listEnv = { ...env, LLVM_PROFILE_FILE: join(scratch, 'list-%p.profraw') };
      const names = listedTests((await execute(artifact.binary, ['--list', '--format', 'terse'], { root, env: listEnv })).stdout);
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
        jobs.push({ binary: artifact.binary, name, id, file, def });
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
      for (let run = 0; run < runs; run++) records.push(await profileFor({ ...job, index, run, scratch, root, env, tools }));
      return records;
    });
    for (let index = 0; index < jobs.length; index++) {
      const job = jobs[index]; const records = outputs[index];
      for (const record of records) for (const [path, lines] of record.files) {
        if (!sources.has(path)) sources.set(path, new Set());
        for (const line of lines.all) sources.get(path).add(line);
      }
      tests.push({ id: job.id, file: job.file, name: job.name, ...(job.def?.tags ? { tags: job.def.tags } : {}),
        status: records.some((record) => record.status === 'failed') ? 'failed' : records.every((record) => record.status === 'skipped') ? 'skipped' : 'passed',
        durationsMs: records.map((record) => record.duration) });
      byTest[job.id] = combineRuns(records.map((record) => record.coverage), unstable);
      if (job.def) { shapes[job.id] = job.def.shape; brittleness.push(...job.def.brittleness.map((finding) => ({ ...finding, test: job.id }))); }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  tests.sort((a, b) => a.id.localeCompare(b.id));
  return { spec: 'cupel-spec/1', kind: 'input', runtime: { name: 'rust', version },
    sources: Object.fromEntries([...sources].sort(([a], [b]) => a.localeCompare(b)).map(([path, lines]) => [path, { coverable: lineSet(lines) }])),
    tests, coverage: { granularity: 'test', byTest, setup: {}, ...(runs > 1 ? { unstable: Object.fromEntries([...unstable].sort(([a], [b]) => a.localeCompare(b)).map(([path, lines]) => [path, lineSet(lines)])) } : {}), rechecked: tests.map((test) => test.id) },
    brittleness, shapes };
}
