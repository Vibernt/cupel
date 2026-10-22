// Collection and mutation for the CLI: loads the node:test collector (src/collect/node/) and the
// mutation module (src/mutate/) on demand, collects the working tree or a git ref unpacked to a
// temporary directory, and runs mutation per config (DESIGN-M3.md).
//
// Test seam: when NODE_ENV=test, CUPEL_TEST_COLLECTOR and CUPEL_TEST_MUTATOR may name module paths
// that replace the real modules. A path that does not exist means "not available". Outside
// NODE_ENV=test both variables are ignored.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { environment } from './errors.mjs';
import { extractRef } from './git.mjs';
import { cmp } from '../engine/order.mjs';

const REAL = {
  collector: { url: new URL('../collect/node/index.mjs', import.meta.url), env: 'CUPEL_TEST_COLLECTOR', exports: ['collectNode'] },
  vitest: { url: new URL('../collect/vitest/index.mjs', import.meta.url), env: 'CUPEL_TEST_VITEST_COLLECTOR', exports: ['collectVitest'] },
  mutator: { url: new URL('../mutate/index.mjs', import.meta.url), env: 'CUPEL_TEST_MUTATOR', exports: ['mutateNode'] },
};


const PY_SRC = fileURLToPath(new URL('../../../cupel-py/src/', import.meta.url));
const quote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;

function hasNodeTests(root) {
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['node_modules', 'venv', '.venv', 'env', 'site-packages'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory() && visit(path)) return true;
      if (entry.isFile() && /\.(test|spec)\.[cm]?js$/.test(entry.name)) return true;
    }
    return false;
  };
  return visit(root);
}

function externalRunner(root, cfg) {
  for (const [name, runner] of Object.entries(cfg.runners ?? {})) {
    if (runner.collector) return { name, ...runner };
  }
  const setupCfg = join(root, 'setup.cfg');
  const pythonProject = existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'pytest.ini')) ||
    (existsSync(setupCfg) && /\[tool:pytest\]|\[pytest\]/.test(readFileSync(setupCfg, 'utf8')));
  if (root && !hasNodeTests(root) && pythonProject) {
    return { name: 'pytest', collector: 'python3 -m vibernt_cupel collect', env: {} };
  }
  return null;
}

function isVitestProject(root, cfg) {
  if (cfg.runners?.vitest) return true;
  const packageFile = join(root, 'package.json');
  if (existsSync(packageFile)) {
    const pkg = JSON.parse(readFileSync(packageFile, 'utf8'));
    if (pkg.dependencies?.vitest || pkg.devDependencies?.vitest || pkg.optionalDependencies?.vitest) return true;
  }
  return readdirSync(root).some((name) => {
    if (/^vitest\.config\.[cm]?[jt]s$/.test(name)) return true;
    return /^vite\.config\.[cm]?[jt]s$/.test(name) && /\btest\s*:/.test(readFileSync(join(root, name), 'utf8'));
  });
}

function collectExternal(runner, { root, runs, recheck = [], log = () => {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'cupel-external-'));
  const output = join(dir, 'input.json');
  try {
    const env = { ...process.env, ...(runner.env ?? {}) };
    if (runner.name === 'pytest') env.PYTHONPATH = [PY_SRC, env.PYTHONPATH].filter(Boolean).join(delimiter);
    if (runner.prepare) {
      const ready = spawnSync(runner.prepare, { cwd: root, env, shell: true, encoding: 'utf8' });
      if (ready.error || ready.status !== 0) throw environment(`prepare failed: ${(ready.stderr || ready.error?.message || '').trim()}`);
    }
    const command = `${runner.collector} --root ${quote(root)} --runs ${runs} ${recheck.map((u) => `--recheck ${quote(u)}`).join(' ')} --out ${quote(output)}`;
    log(`external collector: ${runner.name}`);
    const child = spawnSync(command, { cwd: root, env, shell: true, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (child.error || child.status !== 0) throw environment(`external collector failed (${child.error?.message ?? `exit ${child.status}`}): ${(child.stderr || child.stdout || '').trim().slice(-500)}`);
    if (!existsSync(output)) throw environment('external collector did not write --out file');
    try { return JSON.parse(readFileSync(output, 'utf8')); }
    catch (error) { throw environment(`external collector output is not JSON: ${error.message}`); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Loads the collector or the mutator. Returns null when it is not available. */
export async function loadModule(kind, env = process.env) {
  const spec = REAL[kind];
  let url = spec.url;
  if (env.NODE_ENV === 'test' && env[spec.env]) url = pathToFileURL(resolve(env[spec.env]));
  if (!existsSync(fileURLToPath(url))) return null;
  let mod;
  try {
    mod = await import(url.href);
  } catch (e) {
    throw environment(`${kind} failed to load: ${String(e.message).split('\n')[0]}`);
  }
  for (const name of spec.exports) {
    if (typeof mod[name] !== 'function') throw environment(`${kind} does not export ${name}()`);
  }
  return mod;
}

export async function requireCollector(env, root, cfg) {
  const external = externalRunner(root, cfg);
  if (external) return { collectNode: (opts) => collectExternal(external, opts) };
  if (env.NODE_ENV === 'test' && env.CUPEL_TEST_COLLECTOR) {
    const mod = await loadModule('collector', env);
    if (!mod) throw environment('collector not available');
    return mod;
  }
  if (isVitestProject(root, cfg)) {
    const mod = await loadModule('vitest', env);
    if (!mod) throw environment('Vitest collector not available');
    return { kind: 'vitest', collectNode: mod.collectVitest };
  }
  const mod = await loadModule('collector', env);
  if (!mod) throw environment('collector not available');
  return mod;
}

/** Runs `runners.node.prepare` in `dir`, with `runners.node.env`. A failure exits 3. */
export function runPrepare(dir, cfg, log) {
  const runner = cfg.runners?.node ?? {};
  if (!runner.prepare) return;
  log(`prepare: ${runner.prepare}`);
  const r = spawnSync(runner.prepare, {
    cwd: dir, shell: true, encoding: 'utf8', maxBuffer: 1 << 28,
    env: { ...process.env, ...(runner.env ?? {}) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error || r.status !== 0) {
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-1)[0] ?? '';
    throw environment(`prepare failed (${r.error?.message ?? `exit ${r.status}`})${tail ? `: ${tail}` : ''}`);
  }
}

/** The config with `runners.node.prepare` removed, for a collection whose prepare already ran. */
function withoutPrepare(cfg) {
  if (!cfg.runners?.node?.prepare) return cfg;
  const { prepare, ...node } = cfg.runners.node;
  return { ...cfg, runners: { ...cfg.runners, node } };
}

async function collect(collector, opts) {
  try {
    return await collector.collectNode(opts);
  } catch (e) {
    throw environment(`collector failed: ${String(e?.message ?? e).split('\n')[0]}`);
  }
}

/** Collects the working tree at `root`. The collector runs `prepare` itself. */
export function collectTree(collector, { root, cfg, runs, recheck, log }) {
  log(`collecting ${root}`);
  return collect(collector, { root, config: cfg, runs, recheck: recheck ?? [], log });
}

/**
 * Collects `ref` without touching the working tree: `git archive <ref> | tar -x` into a fresh
 * directory under os.tmpdir(), `prepare` there, collect, then `after(dir, input)` (for mutation),
 * and always clean up.
 */
export async function collectRef(collector, { root, ref, cfg, runs, log }, after) {
  const { dir, commit, cleanup } = extractRef(root, ref);
  try {
    log(`collecting ${ref} (${commit.slice(0, 12)}) in ${dir}`);
    runPrepare(dir, cfg, log);
    const input = await collect(collector, { root: dir, config: withoutPrepare(cfg), runs, recheck: [], log });
    return after ? await after(dir, input) : input;
  } finally {
    cleanup();
  }
}

/** Runs mutateNode for a scope; returns the mutation object, or null when the scope is empty. */
export async function mutate(mutator, { root, cfg, input, scope, log }) {
  const empty = !scope.critical && !(scope.changed && Object.keys(scope.changed).length) && !(scope.targeted ?? []).length;
  if (empty) return null;
  log(`mutating (${[scope.critical && 'critical', scope.changed && 'changed lines', scope.targeted?.length && `${scope.targeted.length} targeted units`].filter(Boolean).join(', ')})`);
  try {
    return await mutator.mutateNode({ root, config: cfg, input, scope: { critical: !!scope.critical, changed: scope.changed ?? null, targeted: scope.targeted ?? [] }, log });
  } catch (e) {
    throw environment(`mutation failed: ${String(e?.message ?? e).split('\n')[0]}`);
  }
}

/** K7: re-runs survivors through confirmSurvivors when the mutator provides it. */
export async function confirm(mutator, { root, input, mutation, ids, log }) {
  if (!ids.length || typeof mutator.confirmSurvivors !== 'function') return mutation;
  log(`confirming ${ids.length} survivors`);
  try {
    const out = await mutator.confirmSurvivors({ root, input, mutation, ids });
    return out && Array.isArray(out.mutants) ? out : mutation;
  } catch (e) {
    throw environment(`mutation failed: ${String(e?.message ?? e).split('\n')[0]}`);
  }
}

const detected = (m) => m.status === 'killed' || m.status === 'timeout';

/** Ids of mutants detected at base and survived at head (same id), for K7. */
export function lostSurvivors(base, head) {
  const before = new Set((base?.mutation?.mutants ?? []).filter(detected).map((m) => m.id));
  return (head?.mutation?.mutants ?? []).filter((m) => m.status === 'survived' && before.has(m.id)).map((m) => m.id).sort(cmp);
}

/** Merges a second mutation result into the first: later mutants replace earlier ones by id. */
export function mergeMutation(a, b) {
  if (!a) return b;
  if (!b) return a;
  const byId = new Map(a.mutants.map((m) => [m.id, m]));
  for (const m of b.mutants) byId.set(m.id, m);
  const out = {
    mutants: [...byId.values()].sort((x, y) => cmp(x.id, y.id)),
    targeted: [...new Set([...(a.targeted ?? []), ...(b.targeted ?? [])])].sort(cmp),
  };
  const seed = b.seed ?? a.seed;
  if (seed !== undefined) out.seed = seed;
  if (a.sampled !== undefined || b.sampled !== undefined) out.sampled = !!(a.sampled || b.sampled);
  return out;
}
