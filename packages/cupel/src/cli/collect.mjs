// Collection and mutation for the CLI: loads the node:test collector (src/collect/node/) and the
// mutation module (src/mutate/) on demand, collects the working tree or a git ref unpacked to a
// temporary directory, and runs mutation per config (DESIGN-M3.md).
//
// Test seam: when NODE_ENV=test, CUPEL_TEST_COLLECTOR and CUPEL_TEST_MUTATOR may name module paths
// that replace the real modules. A path that does not exist means "not available". Outside
// NODE_ENV=test both variables are ignored.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { environment, usage } from './errors.mjs';
import { extractRef } from './git.mjs';
import { cmp } from '../engine/order.mjs';
import { collectorError } from '../collect/error-detail.mjs';
import { mergeRunners, runnerParts } from './merge-runners.mjs';
import { detectRunners, detectedConfig, detectedNodeFiles, isVitestProject, isJestProject } from './runner-discovery.mjs';
import { assertLiveMutationRunner, mutationRequested } from './runner-capabilities.mjs';
import { mutateRuby } from './native-mutation.mjs';

const REAL = {
  collector: { url: new URL('../collect/node/index.mjs', import.meta.url), env: 'CUPEL_TEST_COLLECTOR', exports: ['collectNode'] },
  vitest: { url: new URL('../collect/vitest/index.mjs', import.meta.url), env: 'CUPEL_TEST_VITEST_COLLECTOR', exports: ['collectVitest'] },
  jest: { url: new URL('../collect/jest/index.mjs', import.meta.url), env: 'CUPEL_TEST_JEST_COLLECTOR', exports: ['collectJest'] },
  mutator: { url: new URL('../mutate/index.mjs', import.meta.url), env: 'CUPEL_TEST_MUTATOR', exports: ['mutateNode'] },
  goMutator: { url: new URL('../mutate-go/index.mjs', import.meta.url), env: 'CUPEL_TEST_GO_MUTATOR', exports: ['mutateGo', 'confirmGo'] },
  rustMutator: { url: new URL('../mutate-rust/index.mjs', import.meta.url), env: 'CUPEL_TEST_RUST_MUTATOR', exports: ['mutateRust', 'confirmRust'] },
};


const PY_SRC = fileURLToPath(new URL('../../../cupel-py/src/', import.meta.url));
const CUPEL_BIN = fileURLToPath(new URL('../../bin/cupel.mjs', import.meta.url));
const RUBY_BIN = fileURLToPath(new URL('../../ruby/bin/cupel-ruby', import.meta.url));
const quote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
const mutationOwners = new WeakMap();

function externalRunner(root, cfg) {
  const named = Object.entries(cfg.runners ?? {});
  if (!named.length) {
    const selected = detectRunners(root, cfg);
    if (selected.length === 1 && ['pytest', 'go', 'minitest', 'cargo'].includes(selected[0]))
      return externalRunner(root, { ...cfg, runners: { [selected[0]]: detectedConfig(root, selected[0]) } });
  }
  if (named.length) {
    const [name, runner] = named[0];
    if (runner.collector) return { name, ...runner };
    if (name === 'go') return { name, ...runner, collector: `${quote(process.execPath)} ${quote(CUPEL_BIN)} collect-go` };
    if (name === 'cargo') return { name, ...runner, collector: `${quote(process.execPath)} ${quote(CUPEL_BIN)} collect-cargo` };
    if (name === 'minitest') return { name, ...runner, collector: `ruby ${quote(RUBY_BIN)} collect` };
    if (name === 'pytest') return { name, ...runner, collector: 'python3 -m vibernt_cupel collect' };
    if (name === 'node' || name === 'vitest' || name === 'jest') return null;
    throw usage(`runner ${name} needs a collector command`);
  }
  return null;
}

function collectExternal(runner, { root, runs, recheck = [], log = () => {} }) {
  const scratch = join(root, '.scratch');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'cupel-external-'));
  let preserveDir = false;
  const output = join(dir, 'input.json');
  try {
    const env = { ...process.env, ...(runner.env ?? {}), TMPDIR: dir, XDG_CACHE_HOME: dir };
    if (runner.name === 'pytest') env.PYTHONPATH = [PY_SRC, env.PYTHONPATH].filter(Boolean).join(delimiter);
    if (runner.prepare) {
      const ready = spawnSync(runner.prepare, { cwd: root, env, shell: true, encoding: 'utf8' });
      if (ready.error || ready.status !== 0) {
        preserveDir = true;
        const detail = `stderr:\n${ready.stderr ?? ''}\nstdout:\n${ready.stdout ?? ''}\n${ready.error?.stack ?? ''}`;
        const cause = (ready.stderr || ready.stdout || ready.error?.message || '').trim().split('\n')[0];
        throw environment(collectorError(`external collector prepare failed (${ready.error?.message ?? `exit ${ready.status}`}): ${cause}`, detail, dir));
      }
    }
    const subroot = runner.name === 'cargo' && typeof runner.project === 'string' ? join(root, runner.project) : root;
    const prefix = subroot === root ? '' : `${runner.project.replace(/\\/g, '/').replace(/\/$/, '')}/`;
    const tests = runner.tests && ['go', 'minitest', 'cargo'].includes(runner.name) ? ` --tests ${quote(prefix && runner.name === 'cargo' && runner.tests.startsWith(prefix) ? runner.tests.slice(prefix.length) : runner.tests)}` : '';
    const command = `${runner.collector} --root ${quote(subroot)} --runs ${runs} ${recheck.map((u) => `--recheck ${quote(prefix && u.startsWith(prefix) ? u.slice(prefix.length) : u)}`).join(' ')} --out ${quote(output)}${tests}`;
    log(`external collector: ${runner.name}`);
    const child = spawnSync(command, { cwd: root, env, shell: true, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (child.error || child.status !== 0) {
      preserveDir = true;
      const detail = `stderr:\n${child.stderr ?? ''}\nstdout:\n${child.stdout ?? ''}\n${child.error?.stack ?? ''}`;
      const cause = (child.stderr || child.stdout || child.error?.message || '').trim().split('\n')[0];
      throw environment(collectorError(`external collector failed (${child.error?.message ?? `exit ${child.status}`}): ${cause}`, detail, dir));
    }
    if (runner.name === 'go' && child.stderr.trim()) log(child.stderr.trim());
    if (!existsSync(output)) {
      preserveDir = true;
      throw environment(collectorError('external collector did not write --out file', `stderr:\n${child.stderr ?? ''}\nstdout:\n${child.stdout ?? ''}`, dir));
    }
    try {
      const input = JSON.parse(readFileSync(output, 'utf8'));
      return prefix ? prefixInput(input, prefix) : input;
    }
    catch (error) {
      preserveDir = true;
      throw environment(collectorError(`external collector output is not JSON: ${error.message}`, readFileSync(output, 'utf8'), dir));
    }
  } finally {
    if (!preserveDir) rmSync(dir, { recursive: true, force: true });
  }
}

function prefixInput(input, prefix) {
  const id = (value) => `${prefix}${value}`;
  const paths = (entries) => Object.fromEntries(Object.entries(entries ?? {}).map(([key, value]) => [id(key), value]));
  const lineMaps = (entries) => Object.fromEntries(Object.entries(entries ?? {}).map(([key, value]) => [key, paths(value)]));
  input.sources = paths(input.sources);
  input.tests = input.tests.map((test) => ({ ...test, id: id(test.id), file: id(test.file), ...(test.unit ? { unit: id(test.unit) } : {}) }));
  const cov = input.coverage;
  if (cov.byTest) cov.byTest = Object.fromEntries(Object.entries(lineMaps(cov.byTest)).map(([key, value]) => [id(key), value]));
  if (cov.byFile) cov.byFile = Object.fromEntries(Object.entries(lineMaps(cov.byFile)).map(([key, value]) => [id(key), value]));
  if (cov.setup) cov.setup = Object.fromEntries(Object.entries(lineMaps(cov.setup)).map(([key, value]) => [id(key), value]));
  if (cov.unstable) cov.unstable = paths(cov.unstable);
  if (cov.rechecked) cov.rechecked = cov.rechecked.map(id);
  if (input.shapes) input.shapes = paths(input.shapes);
  if (input.brittleness) input.brittleness = input.brittleness.map((b) => ({ ...b, test: id(b.test) }));
  return input;
}

/** The pytest collector's interpreter and environment also run its mutation command. */
export function mutatePytest({ root, cfg, input, scope, mutation, ids = [] }) {
  const runner = externalRunner(root, cfg);
  if (!runner || runner.name !== 'pytest') throw environment('pytest mutation needs a pytest collector');
  const command = runner.collector.replace(/\s+collect\s*$/, '');
  if (command === runner.collector) throw environment('pytest collector command must end in collect to locate mutate');
  const scratch = join(root, '.scratch');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'cupel-pymut-cli-'));
  try {
    const inputFile = join(dir, 'input.json');
    const scopeFile = join(dir, 'scope.json');
    const configFile = join(dir, 'config.json');
    const mutationFile = join(dir, 'mutation.json');
    const output = join(dir, 'output.json');
    writeFileSync(inputFile, JSON.stringify(input));
    if (scope) writeFileSync(scopeFile, JSON.stringify(scope));
    writeFileSync(configFile, JSON.stringify(cfg));
    if (mutation) writeFileSync(mutationFile, JSON.stringify(mutation));
    const action = mutation ? 'confirm' : 'mutate';
    const args = mutation
      ? `--input ${quote(inputFile)} --mutation ${quote(mutationFile)} --ids ${ids.map(quote).join(' ')}`
      : `--input ${quote(inputFile)} --scope ${quote(scopeFile)}`;
    const env = { ...process.env, ...(runner.env ?? {}), TMPDIR: dir, XDG_CACHE_HOME: dir };
    env.PYTHONPATH = [PY_SRC, env.PYTHONPATH].filter(Boolean).join(delimiter);
    env.PYTHONDONTWRITEBYTECODE = '1';
    const child = spawnSync(`${command} ${action} --root ${quote(root)} --config ${quote(configFile)} ${args} --out ${quote(output)}`, {
      cwd: root, env, shell: true, encoding: 'utf8', maxBuffer: 1 << 28,
    });
    if (child.error || child.status !== 0) throw environment(`pytest mutation failed (${child.error?.message ?? `exit ${child.status}`}): ${(child.stderr || child.stdout || '').trim().slice(-500)}`);
    if (!existsSync(output)) throw environment('pytest mutation did not write --out file');
    const value = JSON.parse(readFileSync(output, 'utf8'));
    return mutation ? value : value.mutation;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function bodySitesPytest({ root, cfg, input }) {
  const runner = externalRunner(root, cfg);
  if (!runner || runner.name !== 'pytest') throw environment('Python body sites need a pytest collector');
  const command = runner.collector.replace(/\s+collect\s*$/, '');
  if (command === runner.collector) throw environment('pytest collector command must end in collect to locate body-sites');
  const scratch = join(root, '.scratch');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'cupel-body-sites-'));
  try {
    const inputFile = join(dir, 'input.json');
    writeFileSync(inputFile, JSON.stringify(input));
    const env = { ...process.env, ...(runner.env ?? {}), PYTHONDONTWRITEBYTECODE: '1', TMPDIR: dir, XDG_CACHE_HOME: dir };
    env.PYTHONPATH = [PY_SRC, env.PYTHONPATH].filter(Boolean).join(delimiter);
    const child = spawnSync(`${command} body-sites --root ${quote(root)} --input ${quote(inputFile)}`, {
      cwd: root, env, shell: true, encoding: 'utf8', maxBuffer: 1 << 26,
    });
    if (child.error || child.status !== 0) throw environment(`Python body sites failed: ${(child.stderr || child.error?.message || '').trim()}`);
    return JSON.parse(child.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  const configured = Object.keys(cfg.runners ?? {});
  const selected = configured.length ? configured : detectRunners(root, cfg);
  if (selected.length > 1) {
    const runners = [];
    for (const name of selected) {
      const config = { ...cfg, runners: { [name]: cfg.runners?.[name] ?? detectedConfig(root, name) } };
      runners.push({ name, config, files: !configured.length && name === 'node' ? detectedNodeFiles(root) : undefined,
        collector: await requireCollector(env, root, config) });
    }
    let lastParts = null;
    return {
      kind: 'merged', runners,
      async collectNode(opts) {
        const parts = [];
        for (const runner of runners) {
          try {
            const previous = lastParts?.find((part) => part.name === runner.name);
            const allowed = previous?.input.tests;
            const recheck = allowed ? (opts.recheck ?? []).filter((id) => allowed.some((test) => (test.unit ?? test.id) === id)) : (opts.recheck ?? []);
            const input = (opts.recheck?.length && previous && !recheck.length)
              ? previous.input
              : await runner.collector.collectNode({ ...opts, recheck, config: runner.config,
                ...(runner.files && !opts.files ? { files: runner.files } : {}) });
            parts.push({ name: runner.name, input });
          } catch (error) {
            throw environment(`runner ${runner.name} collection failed: ${error.message}`);
          }
        }
        lastParts = parts;
        return mergeRunners(parts);
      },
    };
  }
  if (!configured.length && selected.length === 1) {
    return requireCollector(env, root, { ...cfg, runners: { [selected[0]]: selected[0] === 'node' ? {} : detectedConfig(root, selected[0]) } });
  }
  const external = externalRunner(root, cfg);
  if (external) return { collectNode: (opts) => collectExternal(external, opts) };
  if (env.NODE_ENV === 'test' && env.CUPEL_TEST_COLLECTOR) {
    const mod = await loadModule('collector', env);
    if (!mod) throw environment('collector not available');
    return mod;
  }
  if (cfg.runners?.node) {
    const mod = await loadModule('collector', env);
    if (!mod) throw environment('collector not available');
    return mod;
  }
  if (cfg.runners?.jest || (!cfg.runners?.vitest && isJestProject(root, cfg))) {
    const mod = await loadModule('jest', env);
    if (!mod) throw environment('Jest collector not available');
    return { kind: 'jest', collectNode: mod.collectJest };
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
export function collectTree(collector, { root, cfg, runs, recheck, log, diagnostics }) {
  log(`collecting ${root}`);
  return collect(collector, { root, config: cfg, runs, recheck: recheck ?? [], log, diagnostics });
}

/**
 * Collects `ref` without touching the working tree: `git archive <ref> | tar -x` into a fresh
 * directory under os.tmpdir(), `prepare` there, collect, then `after(dir, input)` (for mutation),
 * and always clean up.
 */
export async function collectRef({ root, ref, cfg, runs, log, env = process.env }, after) {
  const { dir, commit, cleanup } = extractRef(root, ref);
  try {
    log(`collecting ${ref} (${commit.slice(0, 12)}) in ${dir}`);
    runPrepare(dir, cfg, log);
    const refConfig = withoutPrepare(cfg);
    const refCollector = await requireCollector(env, dir, refConfig);
    const input = await collect(refCollector, { root: dir, config: refConfig, runs, recheck: [], log });
    return after ? await after(dir, input, refCollector) : input;
  } finally {
    cleanup();
  }
}

/** Runs mutateNode for a scope; returns the mutation object, or null when the scope is empty. */
export async function mutate(mutator, { root, cfg, input, scope, log, collectorKind, diagnostics }) {
  if (!mutationRequested(scope)) return null;
  log(`mutating (${[scope.critical && 'critical', scope.changed && 'changed lines', scope.targeted?.length && `${scope.targeted.length} targeted units`].filter(Boolean).join(', ')})`);
  try {
    const parts = runnerParts(input);
    if (parts) {
      const mutations = [];
      const owners = new Map();
      const plans = parts.map(({ name, input: part }) => {
        const selected = { ...scope,
          changed: scope.changed && Object.fromEntries(Object.entries(scope.changed).filter(([path]) => Object.hasOwn(part.sources, path))),
          targeted: (scope.targeted ?? []).filter((id) => part.tests.some((t) => (t.unit ?? t.id) === id)),
        };
        if (mutationRequested(selected)) {
          assertLiveMutationRunner(part, cfg, undefined, name);
          if (selected.functions && ['go', 'cargo', 'minitest'].includes(name))
            throw environment(`runner ${name}: function-scope mutation is not implemented`);
        }
        return { name, part, selected };
      });
      for (const { name, part, selected } of plans) {
        if (!mutationRequested(selected)) continue;
        const partCfg = { ...cfg, runners: { [name]: cfg.runners?.[name] ?? {} } };
        const result = await mutate(mutator, { root, cfg: partCfg, input: part, scope: selected, log, collectorKind: ['vitest', 'jest'].includes(name) ? name : undefined, diagnostics });
        if (result) {
          mutations.push(result);
          for (const mutant of result.mutants) {
            if (owners.has(mutant.id)) throw environment(`duplicate mutant id across runners: ${mutant.id}`);
            owners.set(mutant.id, name);
          }
        }
      }
      if (!mutations.length) return null;
      const merged = { mutants: mutations.flatMap((m) => m.mutants), targeted: mutations.flatMap((m) => m.targeted ?? []) };
      if (mutations.some((m) => m.sampled !== undefined)) merged.sampled = mutations.some((m) => m.sampled);
      const seeds = [...new Set(mutations.map((m) => m.seed).filter((n) => n !== undefined))];
      if (seeds.length === 1) merged.seed = seeds[0];
      mutationOwners.set(merged, owners);
      return merged;
    }
    assertLiveMutationRunner(input, cfg, collectorKind);
    if (input.runtime.name === 'python') return mutatePytest({ root, cfg, input, scope });
    if (input.runtime.name === 'go') {
      const go = await loadModule('goMutator');
      if (!go) throw environment('Go mutation module is not available');
      return await go.mutateGo({ root, config: cfg, input, scope, log });
    }
    if (input.runtime.name === 'rust') {
      const rust = await loadModule('rustMutator');
      if (!rust) throw environment('Rust mutation module is not available');
      return await rust.mutateRust({ root, config: cfg, input, scope, log });
    }
    if (input.runtime.name === 'ruby') {
      const nativeScope = { ...scope,
        changed: Object.fromEntries(Object.entries(scope.changed ?? {}).filter(([path]) => Object.hasOwn(input.sources, path))),
        targeted: scope.targeted ?? [] };
      return mutateRuby({ runner: externalRunner(root, cfg), root, cfg, input, scope: nativeScope });
    }
    return await mutator.mutateNode({ root, config: cfg, input, scope: { ...(scope.functions ? { functions: true } : {}), critical: !!scope.critical, changed: scope.changed ?? null, targeted: scope.targeted ?? [] }, log, collectorKind, diagnostics });
  } catch (e) {
    throw environment(`mutation failed: ${String(e?.message ?? e).split('\n')[0]}`);
  }
}

/** K7: re-runs survivors through confirmSurvivors when the mutator provides it. */
export async function confirm(mutator, { root, cfg, input, mutation, ids, log, collectorKind }) {
  if (!ids.length) return mutation;
  log(`confirming ${ids.length} survivors`);
  try {
    const parts = runnerParts(input);
    if (parts) {
      const confirmed = [];
      const targeted = [];
      const owners = mutationOwners.get(mutation);
      if (!owners) throw environment('merged mutation has no runner ownership for confirmation');
      for (const { name, input: part } of parts) {
        const relevant = mutation.mutants.filter((m) => owners.get(m.id) === name);
        const selectedIds = ids.filter((id) => relevant.some((m) => m.id === id));
        const unitIds = new Set(part.tests.map((test) => test.unit ?? test.id));
        const partTargeted = (mutation.targeted ?? []).filter((id) => unitIds.has(id));
        const partCfg = { ...cfg, runners: { [name]: cfg.runners?.[name] ?? {} } };
        if (selectedIds.length) {
          const result = await confirm(mutator, { root, cfg: partCfg, input: part,
            mutation: { ...mutation, mutants: relevant, targeted: partTargeted },
            ids: selectedIds, log, collectorKind: ['vitest', 'jest'].includes(name) ? name : undefined });
          confirmed.push(...result.mutants);
          targeted.push(...(result.targeted ?? []));
        } else { confirmed.push(...relevant); targeted.push(...partTargeted); }
      }
      return { ...mutation, mutants: confirmed, targeted: [...new Set(targeted)].sort(cmp) };
    }
    assertLiveMutationRunner(input, cfg, collectorKind);
    if (input.runtime.name === 'python') return mutatePytest({ root, cfg, input, mutation, ids });
    if (input.runtime.name === 'go') {
      const go = await loadModule('goMutator');
      if (!go) throw environment('Go mutation module is not available');
      return await go.confirmGo({ root, config: cfg, input, mutation, ids, log });
    }
    if (input.runtime.name === 'rust') {
      const rust = await loadModule('rustMutator');
      if (!rust) throw environment('Rust mutation module is not available');
      return await rust.confirmRust({ root, config: cfg, input, mutation, ids, log });
    }
    if (input.runtime.name === 'ruby') return mutateRuby({ runner: externalRunner(root, cfg), root, cfg, input, mutation, ids });
    if (typeof mutator.confirmSurvivors !== 'function') throw environment('mutation confirmation is not available');
    const out = await mutator.confirmSurvivors({ root, config: cfg, input, mutation, ids, collectorKind });
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
