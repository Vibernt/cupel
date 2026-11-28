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
import { quote } from './shell-quote.mjs';
import { environment, usage } from './errors.mjs';
import { extractRef } from './git.mjs';
import { cmp } from '../engine/order.mjs';
import { collectorError } from '../collect/error-detail.mjs';
import { mergeRunners, runnerParts, splitRunnerInput } from './merge-runners.mjs';
import { addChanged, combineRows, combineRunnerMutations, ownersFromParts, targetedLinesForOtherRunners } from './runner-mutations.mjs';
import { applyBuiltInto } from './built-into.mjs';
import { detectRunners, detectedConfig, detectedNodeFiles, isVitestProject, isJestProject } from './runner-discovery.mjs';
import { assertLiveMutationRunner, mutationRequested } from './runner-capabilities.mjs';
import { mutateRuby } from './native-mutation.mjs';
import { stampCollection } from './collection.mjs';
import { ReuseBasis, reusableRows, reuseEnabled, stampBasis } from '../mutate/reuse.mjs';

const REAL = {
  collector: { url: new URL('../collect/node/index.mjs', import.meta.url), env: 'CUPEL_TEST_COLLECTOR', exports: ['collectNode'] },
  vitest: { url: new URL('../collect/vitest/index.mjs', import.meta.url), env: 'CUPEL_TEST_VITEST_COLLECTOR', exports: ['collectVitest'] },
  jest: { url: new URL('../collect/jest/index.mjs', import.meta.url), env: 'CUPEL_TEST_JEST_COLLECTOR', exports: ['collectJest'] },
  mutator: { url: new URL('../mutate/index.mjs', import.meta.url), env: 'CUPEL_TEST_MUTATOR', exports: ['mutateNode'] },
  goMutator: { url: new URL('../mutate-go/index.mjs', import.meta.url), env: 'CUPEL_TEST_GO_MUTATOR', exports: ['mutateGo', 'confirmGo'] },
  rustMutator: { url: new URL('../mutate-rust/index.mjs', import.meta.url), env: 'CUPEL_TEST_RUST_MUTATOR', exports: ['mutateRust', 'confirmRust'] },
  cargoMutants: { url: new URL('../mutate-cargo/run.mjs', import.meta.url), env: 'CUPEL_TEST_CARGO_MUTANTS_MUTATOR', exports: ['mutateCargo', 'confirmCargo'] },
};


const PY_SRC = fileURLToPath(new URL('../../../cupel-py/src/', import.meta.url));
const CUPEL_BIN = fileURLToPath(new URL('../../bin/cupel.mjs', import.meta.url));
const RUBY_BIN = fileURLToPath(new URL('../../ruby/bin/cupel-ruby', import.meta.url));
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
      ? `--input ${quote(inputFile)} --mutation ${quote(mutationFile)} --ids ${ids.map((id) => quote(id)).join(' ')}`
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
  return collect(collector, { root, config: cfg, runs, recheck: recheck ?? [], log, diagnostics }).then((input) => stampCollection(applyBuiltInto(input, cfg), root, cfg));
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
    const input = stampCollection(applyBuiltInto(await collect(refCollector, { root: dir, config: refConfig, runs, recheck: [], log }), cfg), dir, cfg, commit);
    return after ? await after(dir, input, refCollector) : input;
  } finally {
    cleanup();
  }
}

/**
 * Runs mutation for a scope; returns the mutation object, or null when the scope is empty.
 * K15: rows of `previous` (an earlier input) whose basis still holds are copied instead of
 * run, and every row of the result gets its basis for the next run.
 */
export async function mutate(mutator, options) {
  const { root, cfg, input, log, previous, ownFiles = [] } = options;
  if (!mutationRequested(options.scope)) return null;
  // Each fault's measured time from the earlier input sharpens plan estimates; every run records its own.
  const history = Object.fromEntries((previous?.mutation?.mutants ?? []).filter((m) => Number.isInteger(m.durationMs)).map((m) => [m.id, m.durationMs]));
  // Which tests caught each fault last time: supported runners try them first (order only, never results).
  const catchers = Object.fromEntries((previous?.mutation?.mutants ?? []).filter((m) => m.killedBy?.length).map((m) => [m.id, m.killedBy]));
  const scope = { ...options.scope, timings: true, ...(Object.keys(history).length ? { history } : {}), ...(Object.keys(catchers).length ? { catchers } : {}) };
  if (!reuseEnabled(cfg)) {
    const result = await mutateRuns(mutator, { ...options, scope });
    return result && scope.firstCatch && !scope.plan ? { ...result, catches: 'first' } : result;
  }
  const basis = new ReuseBasis({ root, input, cfg, ownFiles });
  // Rows from a first-catch run have partial catching-test lists: only another first-catch run may reuse them.
  const usable = previous && (previous.mutation?.catches !== 'first' || scope.firstCatch) ? previous : null;
  const reuse = usable ? reusableRows({ previous: usable, basis }) : {};
  if (previous) log(`reuse: ${Object.keys(reuse).length} of ${previous.mutation.mutants.length} earlier fault results still hold`);
  const result = await mutateRuns(mutator, { ...options, scope: Object.keys(reuse).length ? { ...scope, reuse } : scope });
  if (!result || scope.plan) return result;
  const stamped = stampBasis(scope.firstCatch ? { ...result, catches: 'first' } : result, basis, new Set(Object.keys(reuse)));
  if (mutationOwners.has(result)) mutationOwners.set(stamped, mutationOwners.get(result));
  return stamped;
}

async function mutateRuns(mutator, { root, cfg, input, scope, log, collectorKind, diagnostics, environment: runEnvironment }) {
  if (!mutationRequested(scope)) return null;
  log(`mutating (${[scope.critical && 'critical', scope.changed && 'changed lines', scope.targeted?.length && `${scope.targeted.length} targeted units`].filter(Boolean).join(', ')})`);
  try {
    // A saved multi-runner input (`--input`) is split back into its runners' parts.
    const parts = runnerParts(input) ?? (input.runtimes?.length > 1 ? splitRunnerInput(input) : null);
    if (parts) {
      const mutations = [];
      const plans = parts.map(({ name, input: part }) => {
        const selected = { ...scope,
          changed: scope.changed && Object.fromEntries(Object.entries(scope.changed).filter(([path]) => Object.hasOwn(part.sources, path))),
          targeted: (scope.targeted ?? []).filter((id) => part.tests.some((t) => (t.unit ?? t.id) === id)),
        };
        // Another runner's targeted units: their mutants on sources this runner shares run against its tests too.
        const others = targetedLinesForOtherRunners(input, scope.targeted, part);
        if (Object.keys(others).length) selected.changed = addChanged(selected.changed ?? undefined, others);
        if (mutationRequested(selected)) {
          assertLiveMutationRunner(part, cfg, undefined, name);
          if (selected.functions && ['go', 'cargo', 'minitest'].includes(name))
            throw environment(`runner ${name}: function-scope mutation is not implemented`);
        }
        return { name, part, selected };
      });
      if (scope.runner && !plans.some((p) => p.name === scope.runner)) throw environment(`no runner named ${scope.runner} in this input`);
      if (scope.plan) {
        const out = {};
        for (const { name, part, selected } of plans) {
          if (scope.runner && name !== scope.runner) continue;
          if (!mutationRequested(selected)) { out[name] = { plan: [], sampled: false }; continue; }
          const partCfg = { ...cfg, runners: { [name]: cfg.runners?.[name] ?? {} } };
          out[name] = await planPart(mutator, { root, cfg: partCfg, input: part, scope: selected, log, collectorKind: ['vitest', 'jest'].includes(name) ? name : undefined, diagnostics, environment: runEnvironment });
        }
        return { plans: out };
      }
      for (const { name, part, selected } of plans) {
        if (scope.runner && name !== scope.runner) continue;
        if (!mutationRequested(selected)) continue;
        const partCfg = { ...cfg, runners: { [name]: cfg.runners?.[name] ?? {} } };
        const result = await mutateRuns(mutator, { root, cfg: partCfg, input: part, scope: selected, log, collectorKind: ['vitest', 'jest'].includes(name) ? name : undefined, diagnostics, environment: runEnvironment });
        if (result) mutations.push({ name, part, mutation: result });
      }
      if (!mutations.length) return null;
      // Runners that test the same source plant the same mutants: one combined row each (K14).
      const combined = combineRunnerMutations(mutations);
      if (combined.dropped.length) log(`mutate: ${combined.dropped.length} fault(s) not run by every runner whose tests cover them; left out (sampled)`);
      let merged = combined.mutation;
      const owners = combined.owners;
      if (cfg.runners?.cargo?.mutants?.crossRunner && owners.size) {
        // Phase 7: Rust survivors in sources built into an artifact get re-tested by the tests that load it.
        const { crossRunner } = await import('./cross-runner.mjs');
        const { listMutants } = await import('../mutate-cargo/run.mjs');
        merged = await crossRunner({ root, cfg, input, mutation: merged, listing: await listMutants({ root, config: cfg }), log });
      }
      mutationOwners.set(merged, owners);
      return merged;
    }
    if (scope.plan && !scope.backendPlan) {
      const name = runnerNameOf(input, cfg, collectorKind);
      if (scope.runner && scope.runner !== name) throw environment(`no runner named ${scope.runner} in this input`);
      return { plans: { [name]: await planPart(mutator, { root, cfg, input, scope, log, collectorKind, diagnostics, environment: runEnvironment }) } };
    }
    if (scope.runner && runnerNameOf(input, cfg, collectorKind) !== scope.runner) throw environment(`no runner named ${scope.runner} in this input`);
    if ((scope.plan || scope.only) && !sliceable(input, cfg)) throw environment(`runner ${runnerNameOf(input, cfg, collectorKind)}: slices are not available for this runner`);
    assertLiveMutationRunner(input, cfg, collectorKind);
    if (input.runtime.name === 'python') return mutatePytest({ root, cfg, input, scope });
    if (input.runtime.name === 'go') {
      const go = await loadModule('goMutator');
      if (!go) throw environment('Go mutation module is not available');
      return await go.mutateGo({ root, config: cfg, input, scope, log });
    }
    if (input.runtime.name === 'rust') return await rustMutation('mutate', { root, cfg, input, scope, log, environment: runEnvironment });
    if (input.runtime.name === 'ruby') {
      // Ruby consumes catchers and firstCatch, but K15 reuse is withheld until the basis includes
      // installed gems and Bundler/Gem path selectors; project lockfiles alone cannot prove parity.
      const { reuse: _reuse, ...rubyScope } = scope;
      const nativeScope = { ...rubyScope,
        changed: Object.fromEntries(Object.entries(scope.changed ?? {}).filter(([path]) => Object.hasOwn(input.sources, path))),
        targeted: scope.targeted ?? [] };
      return mutateRuby({ runner: externalRunner(root, cfg), root, cfg, input, scope: nativeScope });
    }
    const nodeScope = { ...(scope.functions ? { functions: true } : {}), critical: !!scope.critical, changed: scope.changed ?? null, targeted: scope.targeted ?? [],
      ...Object.fromEntries(['reuse', 'plan', 'only', 'history', 'catchers', 'timings', 'firstCatch'].filter((k) => scope[k] !== undefined).map((k) => [k, scope[k]])) };
    const ordinary = await mutator.mutateNode({ root, config: cfg, input, scope: nodeScope, log, collectorKind, diagnostics });
    // Phase 5: sources the tests run in workerd get their mutants in a scratch copy of the project.
    if (collectorKind || !Object.values(input.sources).some((s) => s.measuredIn)) return ordinary;
    const scratch = await mutator.mutateNode({ root, config: cfg, input, scope: nodeScope, log, collectorKind, diagnostics, scratch: true });
    if (scope.plan) return { plan: [...(ordinary?.plan ?? []), ...(scratch?.plan ?? [])], sampled: !!(ordinary?.sampled || scratch?.sampled), seed: ordinary?.seed };
    return mergePasses(input, ordinary, scratch);
  } catch (e) {
    throw environment(`mutation failed: ${String(e?.message ?? e).split('\n')[0]}`);
  }
}

/** The runner name of a single-runner input. */
function runnerNameOf(input, cfg, collectorKind) {
  const configured = Object.keys(cfg.runners ?? {});
  if (configured.length === 1) return configured[0];
  return input.tests?.find((t) => t.runner)?.runner ?? collectorKind
    ?? ({ python: 'pytest', node: 'node', go: 'go', rust: 'cargo', ruby: 'minitest' }[input.runtime?.name] ?? input.runtime?.name);
}

/** Runners whose mutators can plan and run slices: node, Vitest, Jest, pytest, and Rust through cargo-mutants or Cupel. */
function sliceable(input, cfg) {
  if (['go', 'ruby'].includes(input.runtime?.name)) return false;
  return !(input.runtime?.name === 'rust' && cfg.runners?.cargo?.mutants?.backend === 'cupel-rust');
}

/** One runner's plan, or why it has none. */
async function planPart(mutator, options) {
  if (!sliceable(options.input, options.cfg)) return { plan: null, unsupported: 'this runner cannot plan slices; it runs whole' };
  const result = await mutateRuns(mutator, { ...options, scope: { ...options.scope, plan: true, backendPlan: true } });
  return result?.plans ? Object.values(result.plans)[0] : result;
}

/** Rust mutation: cargo-mutants by default (D19), or the restricted built-in mutator on request. */
async function rustMutation(action, { root, cfg, input, scope, mutation, ids, log, environment: runEnvironment }) {
  const settings = cfg.runners?.cargo?.mutants ?? {};
  if (settings.backend === 'cupel-rust') {
    const rust = await loadModule('rustMutator');
    if (!rust) throw environment('Rust mutation module is not available');
    const { mutants: _backend, ...cargo } = cfg.runners?.cargo ?? {};
    const legacy = { ...cfg, runners: { ...cfg.runners, cargo } };
    if (!Object.keys(cargo).length) delete legacy.runners.cargo;
    if (!Object.keys(legacy.runners).length) delete legacy.runners;
    return action === 'mutate'
      ? await rust.mutateRust({ root, config: legacy, input, scope, log })
      : await rust.confirmRust({ root, config: legacy, input, mutation, ids, log });
  }
  const cargo = await loadModule('cargoMutants');
  if (!cargo) throw environment('cargo-mutants mutation module is not available');
  if (settings.backend === 'cupel' && action === 'mutate') {
    const { mutateCargoFast } = await import('../mutate-cargo/fast.mjs');
    return await mutateCargoFast({ root, config: cfg, input, scope, log, environment: runEnvironment });
  }
  return action === 'mutate'
    ? await cargo.mutateCargo({ root, config: cfg, input, scope, log })
    : await cargo.confirmCargo({ root, config: cfg, input, mutation, ids, log });
}

/** K7: re-runs survivors through confirmSurvivors when the mutator provides it; changed rows get a new basis (K15). */
export async function confirm(mutator, options) {
  const { root, cfg, input, mutation, ownFiles = [] } = options;
  const result = await confirmRuns(mutator, options);
  if (result === mutation || !result || !reuseEnabled(cfg)) return result;
  const kept = new Set(result.mutants.filter((row) => row.reused).map((row) => row.id));
  return stampBasis(result, new ReuseBasis({ root, input, cfg, ownFiles }), kept);
}

async function confirmRuns(mutator, { root, cfg, input, mutation, ids, log, collectorKind }) {
  if (!ids.length) return mutation;
  log(`confirming ${ids.length} survivors`);
  try {
    // A merged input read from a file has no in-memory parts: split it by runner, as a run does.
    const parts = runnerParts(input) ?? (input.runtimes?.length > 1 ? splitRunnerInput(input) : null);
    if (parts) {
      const confirmed = [];
      const targeted = [];
      // Every runner that ran a survivor confirms it; the confirmations combine like the runs (K14).
      const owners = mutationOwners.get(mutation) ?? ownersFromParts(mutation, parts);
      const rowsById = new Map();
      for (const { name, input: part } of parts) {
        const relevant = mutation.mutants.filter((m) => (owners.get(m.id) ?? []).includes(name));
        const selectedIds = ids.filter((id) => relevant.some((m) => m.id === id));
        const unitIds = new Set(part.tests.map((test) => test.unit ?? test.id));
        const partTargeted = (mutation.targeted ?? []).filter((id) => unitIds.has(id));
        const partCfg = { ...cfg, runners: { [name]: cfg.runners?.[name] ?? {} } };
        if (selectedIds.length) {
          const result = await confirmRuns(mutator, { root, cfg: partCfg, input: part,
            mutation: { ...mutation, mutants: relevant, targeted: partTargeted },
            ids: selectedIds, log, collectorKind: ['vitest', 'jest'].includes(name) ? name : undefined });
          confirmed.push(...result.mutants);
          targeted.push(...(result.targeted ?? []));
        } else { confirmed.push(...relevant); targeted.push(...partTargeted); }
      }
      const asked = new Set(ids);
      for (const row of confirmed) if (asked.has(row.id)) { if (!rowsById.has(row.id)) rowsById.set(row.id, []); rowsById.get(row.id).push(row); }
      // A confirmed row takes the combined status and catchers of its runners' confirmations; its measured time and
      // everything else stay those of the original row. Rows not asked about are unchanged.
      const mutants = mutation.mutants.map((row) => {
        const again = rowsById.get(row.id);
        if (!again) return row;
        const { status, killedBy, killKinds } = combineRows(again);
        const { killedBy: _k, killKinds: _kk, ...rest } = row;
        // A row whose answer changed on confirmation is a new result, not one copied from an earlier run.
        if (status !== row.status) delete rest.reused;
        return { ...rest, status, ...(killedBy ? { killedBy } : {}), ...(killKinds ? { killKinds } : {}) };
      });
      return { ...mutation, mutants, targeted: [...new Set(targeted)].sort(cmp) };
    }
    assertLiveMutationRunner(input, cfg, collectorKind);
    if (input.runtime.name === 'python') return mutatePytest({ root, cfg, input, mutation, ids });
    if (input.runtime.name === 'go') {
      const go = await loadModule('goMutator');
      if (!go) throw environment('Go mutation module is not available');
      return await go.confirmGo({ root, config: cfg, input, mutation, ids, log });
    }
    if (input.runtime.name === 'rust') return await rustMutation('confirm', { root, cfg, input, mutation, ids, log });
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
/**
 * Merges an ordinary and a scratch-mode mutation pass over disjoint sources. A
 * unit stays targeted only if every pass whose sources hold its own lines lists it.
 */
export function mergePasses(input, ordinary, scratch) {
  if (!scratch) return ordinary;
  if (!ordinary) return scratch;
  const measured = new Set(Object.entries(input.sources).filter(([, s]) => s.measuredIn).map(([p]) => p));
  const ownSources = new Map();
  for (const t of input.tests) {
    const unit = t.unit ?? t.id;
    if (!ownSources.has(unit)) ownSources.set(unit, new Set());
    for (const source of Object.keys(input.coverage?.byTest?.[t.id] ?? {})) ownSources.get(unit).add(source);
  }
  const inOrdinary = new Set(ordinary.targeted ?? []); const inScratch = new Set(scratch.targeted ?? []);
  const targeted = [...new Set([...inOrdinary, ...inScratch])].filter((unit) => {
    const sources = [...(ownSources.get(unit) ?? [])];
    return (!sources.some((x) => !measured.has(x)) || inOrdinary.has(unit)) && (!sources.some((x) => measured.has(x)) || inScratch.has(unit));
  }).sort(cmp);
  const merged = mergeMutation(ordinary, scratch);
  return { ...merged, targeted };
}

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
