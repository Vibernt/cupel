// Reuse of earlier fault results (SPEC K15).
//
// A fault result can only change when something its tests read changes. Each mutant
// row gets a `basis`: a SHA-256 over everything that could change its outcome —
//   - the row's id, source and line, and the ids of the passed tests that run that line;
//   - the content of every project file, except sources and test files that those
//     tests do not run (coverage says so), and files config `mutation.reuse.ignore` names;
//   - Cupel's version, the OS and CPU, the runtimes, the runner config and a few
//     environment variables that change how tests run.
// A later run may copy a `killed`, `survived` or `no-coverage` row from an earlier input
// when its basis is the same now. Timeouts and errors always run again. The earlier
// input is an ordinary Cupel input file, so CI on fresh machines keeps it as an
// artifact or cache entry and passes it back.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { anyGlobMatches } from '../engine/match.mjs';
import { lines as parseLines } from '../engine/lines.mjs';
import { cmp } from '../engine/order.mjs';

export const REUSABLE = Object.freeze(['killed', 'survived', 'no-coverage']);
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'target', '.cupel', '.scratch',
  '__pycache__', '.venv', 'venv', '.tox', '.nox', '.pytest_cache', '.mypy_cache', '.ruff_cache']);
const OWN_DIRS = new Set(['.cupel', '.scratch']);
const ENV_KEYS = ['NODE_OPTIONS', 'NODE_ENV', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHASHSEED', 'PYTHONOPTIMIZE',
  'PYTHONWARNINGS', 'PYTEST_ADDOPTS', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'RUSTDOCFLAGS', 'CARGO_BUILD_RUSTFLAGS',
  'GOFLAGS', 'GOOS', 'GOARCH', 'CGO_ENABLED', 'RUBYOPT', 'CI', 'TZ', 'LANG', 'LC_ALL'];
// Languages whose compiler copies code across files (constants, macros, generics, inlining):
// coverage cannot say which sources a test depends on, so every source is part of the basis.
const COMPILED = /\.(rs|go|c|cc|cpp|h|hpp)$/;
// What the installed dependencies are, read from the package managers' own records.
const DEPENDENCY_RECORDS = ['node_modules/.package-lock.json', 'node_modules/.modules.yaml', 'node_modules/.yarn-state.yml',
  'node_modules/.yarn-integrity'];
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

const sha = (data) => createHash('sha256').update(data).digest('hex');
const skipped = (path) => path.split('/').some((part) => SKIP_DIRS.has(part));

/** Whether reuse is switched on in an effective config (`mutation.reuse`, default on). */
export function reuseEnabled(cfg) {
  return cfg?.mutation?.reuse !== false;
}

function reuseOption(cfg, key) {
  const r = cfg?.mutation?.reuse;
  return r && typeof r === 'object' && Array.isArray(r[key]) ? r[key] : [];
}

function gitTop(root) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  if (top.error || top.status !== 0) return null;
  try { return realpathSync(top.stdout.trim()); } catch { return null; }
}

function walkFiles(root, dir, prefix, out) {
  let entries;
  // A folder removed while Cupel reads the tree (a test's own temporary files) is simply gone.
  try { entries = readdirSync(join(root, dir), { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return; throw error; }
  for (const e of entries) {
    const path = `${prefix}${e.name}`;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walkFiles(root, join(dir, e.name), `${path}/`, out); }
    else if (e.isFile() || e.isSymbolicLink()) out.push(path);
  }
}

/**
 * The project's files, relative to root. In git: tracked, untracked and ignored files
 * (ignored build output or `.env` files can be read by tests), with dependency, build and
 * cache folders left out; submodules are read as folders. Outside git: a walk with the
 * same folders left out. Cupel's own folders are never project files.
 */
export function projectFiles(root) {
  const real = realpathSync(root);
  const out = [];
  if (gitTop(root) === real) {
    const list = (args) => {
      const r = spawnSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 });
      if (r.error || r.status !== 0) throw new Error(`git ls-files failed: ${(r.stderr || r.error?.message || '').trim().split('\n')[0]}`);
      return r.stdout.split('\0').filter(Boolean);
    };
    // Files git tracks or would track are always read (Cupel's own folders aside); ignored files
    // are read unless they sit in a dependency, build or cache folder.
    const kept = list(['--cached', '--others', '--exclude-standard']).filter((p) => !OWN_DIRS.has(p.split('/')[0]));
    const ignored = list(['--others', '--ignored', '--exclude-standard', '--directory']).filter((p) => !skipped(p.replace(/\/$/, '')));
    for (const path of [...kept, ...ignored]) {
      const clean = path.replace(/\/$/, '');
      let st;
      try { st = lstatSync(join(root, clean)); } catch { continue; }
      if (st.isDirectory()) walkFiles(root, clean, `${clean}/`, out);
      else out.push(clean);
    }
  } else walkFiles(root, '', '', out);
  return [...new Set(out)].sort(cmp);
}

function hashFile(full, st) {
  try { return sha(readFileSync(full)); }
  catch (error) {
    // A file the user cannot read is one the tests cannot read either: only its presence counts.
    if (error.code === 'EACCES' || error.code === 'EPERM') return sha(`unreadable:${st.mode}`);
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** SHA-256 of each file's bytes; a symbolic link: its target text and, for a file target, the target's bytes. */
export function fileHashes(root, files = projectFiles(root)) {
  const out = new Map();
  for (const path of files) {
    const full = join(root, path);
    let st;
    try { st = lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) {
      let target = null;
      try { const t = statSync(full); if (t.isFile()) target = hashFile(full, t); } catch { /* a dangling link: its text alone */ }
      out.set(path, sha(`link:${readlinkSync(full)}\0${target ?? ''}`));
    } else if (st.isFile()) {
      const h = hashFile(full, st);
      if (h) out.set(path, h);
    }
  }
  return out;
}

/**
 * State outside the project's own files that changes test results: installed dependencies
 * (package managers' records, Python virtual environments' installed distributions), and,
 * for a project inside a larger repository, the files directly in each enclosing folder up
 * to the repository root (shared manifests, lock files and tool configs).
 */
export function outsideState(root, env = process.env) {
  const out = new Map();
  const real = realpathSync(root);
  for (const rel of DEPENDENCY_RECORDS) {
    const full = join(real, rel);
    let st; try { st = statSync(full); } catch { continue; }
    if (st.isFile()) { const h = hashFile(full, st); if (h) out.set(`<deps>/${rel}`, h); }
  }
  const venvs = new Set(['.venv', 'venv'].map((d) => join(real, d)));
  if (env.VIRTUAL_ENV) venvs.add(env.VIRTUAL_ENV);
  for (const venv of [...venvs].sort(cmp)) {
    for (const lib of ['lib', 'Lib']) {
      let dirs; try { dirs = readdirSync(join(venv, lib)); } catch { continue; }
      for (const py of dirs.sort(cmp)) {
        const site = lib === 'Lib' ? join(venv, lib, 'site-packages') : join(venv, lib, py, 'site-packages');
        let names; try { names = readdirSync(site).filter((n) => /\.(dist|egg)-info$/.test(n) || n.endsWith('.pth')).sort(cmp); } catch { continue; }
        out.set(`<deps>/${relative(real, site).split(sep).join('/')}`, sha(names.join('\n')));
        if (lib === 'Lib') break;
      }
    }
  }
  const top = gitTop(root);
  if (top && top !== real && real.startsWith(`${top}${sep}`)) {
    for (let dir = dirname(real); dir.length >= top.length; dir = dirname(dir)) {
      let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { break; }
      for (const e of entries) {
        if (!e.isFile()) continue;
        const h = hashFile(join(dir, e.name), lstatSync(join(dir, e.name)));
        if (h) out.set(`<up>/${relative(top, join(dir, e.name)).split(sep).join('/')}`, h);
      }
      if (dir === top) break;
    }
  }
  return out;
}

/**
 * Computes bases for an input. One instance per input and project state: file hashes
 * are read once, and the part of a basis shared by mutants run by the same test files
 * is computed once.
 */
export class ReuseBasis {
  constructor({ root, input, cfg, env = process.env, hashes, ownFiles = [] }) {
    this.input = input;
    this.hashes = hashes ?? fileHashes(root);
    // Cupel's own input and output files (--reuse, --out) change on every run and no test reads them.
    for (const file of ownFiles) {
      let real = file;
      try { real = realpathSync(file); } catch { try { real = join(realpathSync(dirname(file)), basename(file)); } catch { /* keep as given */ } }
      const rel = relative(realpathSync(root), real).split(sep).join('/');
      if (rel && !rel.startsWith('..')) this.hashes.delete(rel);
    }
    this.ignore = reuseOption(cfg, 'ignore');
    const envKeys = [...new Set([...ENV_KEYS, ...reuseOption(cfg, 'env')])].sort(cmp);
    for (const [key, hash] of outsideState(root, env)) this.hashes.set(key, hash);
    this.context = JSON.stringify({
      format: 'cupel-reuse/1', cupel: VERSION, platform: process.platform, arch: process.arch,
      runtime: input.runtime ?? null, runtimes: input.runtimes ?? null, runners: cfg?.runners ?? {},
      ignore: this.ignore, env: Object.fromEntries(envKeys.filter((k) => env[k] !== undefined).map((k) => [k, env[k]])),
    });
    const cov = input.coverage ?? {};
    this.byTest = cov.byTest ?? {};
    this.fileIndexes = [cov.setup ?? {}, cov.byFile ?? {}];
    this.passed = (input.tests ?? []).filter((t) => t.status === 'passed');
    this.passedFiles = new Set(this.passed.map((t) => t.file));
    this.testFiles = new Set((input.tests ?? []).map((t) => t.file));
    this.parsed = new Map();
    this.shared = new Map();
  }

  covers(value, line) {
    if (value === undefined) return false;
    let iv = this.parsed.get(value);
    if (!iv) { iv = parseLines(String(value)); this.parsed.set(value, iv); }
    return iv.some(([a, b]) => line >= a && line <= b);
  }

  /** The passed tests that run a line, and the test files a mutant run starts (as Session.select). */
  running(source, line) {
    const tests = this.passed.filter((t) => this.covers(this.byTest[t.id]?.[source], line)).map((t) => t.id).sort(cmp);
    const files = new Set(this.passed.filter((t) => tests.includes(t.id)).map((t) => t.file));
    for (const index of this.fileIndexes) {
      for (const [file, cov] of Object.entries(index)) if (this.passedFiles.has(file) && this.covers(cov?.[source], line)) files.add(file);
    }
    return { tests, files: [...files].sort(cmp) };
  }

  /**
   * The digest of every file that can change the outcome when these test files run. With
   * `allSources`, every source counts, not only those the tests' coverage shows.
   */
  dependencies(files, allSources) {
    const key = `${allSources ? 'all' : 'run'}\0${files.join('\0')}`;
    if (this.shared.has(key)) return this.shared.get(key);
    const ran = new Set(files);
    const sourcesRun = new Set();
    for (const t of this.passed) {
      if (!ran.has(t.file)) continue;
      for (const source of Object.keys(this.byTest[t.id] ?? {})) sourcesRun.add(source);
    }
    for (const index of this.fileIndexes) for (const file of files) for (const source of Object.keys(index[file] ?? {})) sourcesRun.add(source);
    const h = createHash('sha256');
    for (const [path, hash] of this.hashes) {
      // A source no selected test covers cannot change the result, unless it could not be measured: then tests may
      // run it unseen, so its bytes stay in the basis.
      if (!allSources && Object.hasOwn(this.input.sources ?? {}, path) && this.input.sources[path].unmeasured === undefined && !sourcesRun.has(path)) continue;
      if (this.testFiles.has(path) && !ran.has(path)) continue;
      if (this.ignore.length && anyGlobMatches(this.ignore, path)) continue;
      h.update(`${path}\0${hash}\n`);
    }
    const digest = h.digest('hex');
    this.shared.set(key, digest);
    return digest;
  }

  /**
   * Whether coverage can miss sources these test files depend on: a compiled language (its
   * compiler copies constants, macros and generics across files), or a test that starts
   * another program or interpreter, or an end-to-end test, whose code coverage may not see.
   */
  needsAllSources(source, files) {
    if (COMPILED.test(source)) return true;
    const ran = new Set(files);
    return (this.input.tests ?? []).some((t) => ran.has(t.file) && (t.spawnsInterpreter || t.kind === 'e2e' || COMPILED.test(t.file)));
  }

  /** A mutant row's basis. */
  of(row) {
    const { tests, files } = this.running(row.source, row.line);
    const all = this.needsAllSources(row.source, files);
    return 'sha256:' + sha(`${this.context}\n${row.id}\0${row.source}\0${row.line}\n${tests.join('\0')}\n${files.join('\0')}\n${this.dependencies(files, all)}`);
  }

  /** Whether every test credited with catching the row is in a file its run starts (not true of cross-runner catches). */
  killersInRun(row) {
    if (!row.killedBy?.length) return true;
    const { files } = this.running(row.source, row.line);
    const ran = new Set(files);
    const fileOf = new Map((this.input.tests ?? []).map((t) => [t.id, t.file]));
    return row.killedBy.every((id) => ran.has(fileOf.get(id)));
  }
}

/** Reads an earlier input for reuse; null when it is absent or not a Cupel input with mutation. */
export function readPrevious(path, { required = false } = {}) {
  let doc;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (required) throw new Error(`cannot read ${path}: ${error.code ?? error.message}`);
    return null;
  }
  if (doc?.kind !== 'input' || !Array.isArray(doc?.mutation?.mutants)) {
    if (required) throw new Error(`${path} is not a Cupel input with mutation results`);
    return null;
  }
  return doc;
}

/**
 * The earlier input for a run: none when `off`; `file` when given (a missing file is a cache
 * miss on a fresh CI machine, so every fault runs; an existing file must be a valid input);
 * otherwise `<root>/.cupel/input.json` when it exists and holds mutation results.
 */
export function previousInput({ file, off = false, root, log = () => {} }) {
  if (off) return null;
  if (file !== undefined) {
    if (!existsSync(file)) { log(`reuse: ${file} not found; every fault runs`); return null; }
    return readPrevious(file, { required: true });
  }
  return readPrevious(join(root, '.cupel', 'input.json'));
}

/**
 * The rows of an earlier input that may be copied now: reusable status, a basis, and the same
 * basis today. Returns a plain object id -> row (marked `reused: true`), for every backend.
 */
export function reusableRows({ previous, basis }) {
  const out = {};
  for (const row of previous?.mutation?.mutants ?? []) {
    if (!REUSABLE.includes(row.status) || typeof row.basis !== 'string') continue;
    if (Object.hasOwn(out, row.id)) continue;
    if (basis.of(row) === row.basis && basis.killersInRun(row)) out[row.id] = { ...row, reused: true };
  }
  return out;
}

/** Adds `basis` to every row that lacks one; a row not copied from earlier loses any stale `reused` mark. */
export function stampBasis(mutation, basis, reusedIds = new Set()) {
  if (!mutation) return mutation;
  return { ...mutation, mutants: mutation.mutants.map((row) => {
    const out = { ...row };
    if (!reusedIds.has(row.id)) delete out.reused;
    if (!out.reused || typeof out.basis !== 'string') out.basis = basis.of(out);
    return out;
  }) };
}
