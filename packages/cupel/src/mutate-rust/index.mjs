import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { effectiveConfig } from '../engine/config.mjs';
import { schemaDiagnostics, integrityDiagnostics } from '../engine/integrity.mjs';
import { cmp } from '../engine/order.mjs';
import { mutationModel } from '../mutate/model.mjs';
import { RustInventory } from './inventory.mjs';
import { refuse } from './errors.mjs';
import { RustSession } from './runner.mjs';
import { scopeRust, lineIn } from './scope.mjs';
import { sourceSites } from './sites.mjs';

const SCHEMA = JSON.parse(readFileSync(new URL('../../schemas/config.schema.json', import.meta.url), 'utf8'));
const INPUT_SCHEMA = JSON.parse(readFileSync(new URL('../../schemas/input.schema.json', import.meta.url), 'utf8'));
const noop = () => {};

function validateInput(input) {
  const problems = schemaDiagnostics(INPUT_SCHEMA, input, 'invalid-input', null);
  if (!problems.length) problems.push(...integrityDiagnostics(input));
  if (problems.length) refuse('input', `Rust mutation input is invalid: ${problems[0].message}`);
}

function validateConfig(config) {
  for (const [key,value] of Object.entries(config.runners?.cargo ?? {}))
    if (key !== 'command' || value !== 'cargo test') refuse('unsupported-rust-config', `Cargo mutation does not support configured ${key}; requires ordinary cargo test`);
  const { words: _derivedWords, ...declared } = config;
  const problems = schemaDiagnostics(SCHEMA, declared, 'invalid-config', null);
  if (problems.length) refuse('config', `Rust mutation config is invalid: ${problems[0].message}`);
}

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let n = Math.imul(state ^ (state >>> 15), state | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, seed) {
  const result = [...items];
  const next = random(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

const mine = (site, own) => [...own.values()].some((row) => row.has(site.source) && lineIn(row.get(site.source), site.line));

function orderSites(sites, own, cap, seed) {
  const targeted = sites.filter((site) => mine(site, own));
  const other = sites.filter((site) => !mine(site, own));
  if (sites.length <= cap) return sites;
  if (targeted.length < cap) return [...targeted, ...shuffle(other, seed)];
  const selected = new Set();
  const units = [...own].map(([uid, rows]) => ({ uid, sites: targeted.filter((site) => rows.has(site.source) && lineIn(rows.get(site.source), site.line)) }))
    .filter((unit) => unit.sites.length)
    .sort((a, b) => a.sites.length - b.sites.length || cmp(a.uid, b.uid));
  for (const unit of units) {
    const extra = unit.sites.filter((site) => !selected.has(site));
    if (selected.size + extra.length <= cap) for (const site of extra) selected.add(site);
  }
  return [...targeted.filter((site) => selected.has(site)), ...shuffle(other, seed),
    ...shuffle(targeted.filter((site) => !selected.has(site)), seed)];
}

function entry(site, result) {
  return { id: site.id, source: site.source, line: site.line, operator: site.operator,
    status: result.status, ...(result.killedBy?.length ? { killedBy: result.killedBy } : {}) };
}

function completeUnits(own, sites, results, invalid) {
  return [...own].filter(([, rows]) => {
    const candidates = sites.filter((site) => !invalid.has(site.id) && rows.has(site.source) && lineIn(rows.get(site.source), site.line));
    return candidates.length > 0 && candidates.every((site) =>
      ['killed', 'survived', 'no-coverage'].includes(results.get(site.id)?.status));
  }).map(([uid]) => uid).sort();
}

async function checkedSite(session, site) {
  let result = await session.check(site);
  if (!result || result.invalid || result.status !== 'survived') return result;
  for (let rep = 0; rep < 2; rep++) {
    result = await session.check(site);
    if (result?.invalid) refuse('environment', `Rust mutant became compile-invalid during confirmation: ${site.id}`);
    if (!result || result.status !== 'survived') return result;
  }
  return result;
}

/** Actual Rust mutation with ordinary complete-crate tests and no project source edits. */
export async function mutateRust({ root, input, config = {}, scope = {}, log = noop, metrics } = {}) {
  const started = performance.now();
  validateInput(input);
  validateConfig(config);
  const cfg = effectiveConfig(config, SCHEMA);
  const { maxMutants, maxSeconds, seed } = cfg.mutation;
  const facts = new RustInventory(root, input, metrics);
  const { wanted, own } = scopeRust(input, cfg, scope);
  if (!wanted.size) return { mutants: [], targeted: [], seed, sampled: false };
  const session = new RustSession(facts, input, started + maxSeconds * 1000, metrics);
  try {
    await session.prepare();
    facts.assertFresh();
    const sites = [];
    for (const [source, lines] of [...wanted].sort(([a], [b]) => cmp(a, b)))
      sites.push(...sourceSites(facts, source, lines));
    const unique = new Set(sites.map((site) => site.id));
    if (unique.size !== sites.length) refuse('rust-sites', 'Rust AST emitted duplicate mutation IDs');
    const ordered = orderSites(sites, own, maxMutants, seed);
    const results = new Map();
    const invalid = new Set();
    for (const site of ordered) {
      if (results.size >= maxMutants || session.remaining() < 1) break;
      const result = await checkedSite(session, site);
      if (!result) break;
      if (result.invalid) { invalid.add(site.id); continue; }
      results.set(site.id, result);
      if (metrics) metrics.run = results.size;
    }
    facts.assertFresh();
    const mutants = sites.filter((site) => results.has(site.id)).map((site) => entry(site, results.get(site.id)));
    const sampled = sites.some((site) => !results.has(site.id) && !invalid.has(site.id));
    if (metrics) Object.assign(metrics, { sites: sites.length, invalid: invalid.size, sampled });
    log(`mutate-rust: ${sites.length} sites, ${invalid.size} compile-invalid, ${mutants.length} run`);
    return { mutants, targeted: completeUnits(own, sites, results, invalid), seed, sampled };
  } finally { session.close(); }
}

/** Historical confirmation: regenerate IDs from pinned bytes and run two required repetitions. */
export async function confirmRust({ root, input, mutation, ids, config = {}, log = noop, metrics } = {}) {
  validateInput(input);
  validateConfig(config);
  const cfg = effectiveConfig(config, SCHEMA);
  const byId = new Map(mutation.mutants.map((row, index) => [row.id, index]));
  for (const id of ids) if (!byId.has(id)) refuse('confirmation', `Rust mutant is absent from mutation result: ${id}`);
  const todo = [...new Set(ids)].sort().filter((id) => mutation.mutants[byId.get(id)].status === 'survived');
  const output = { ...mutation, mutants: mutation.mutants.map((row) => ({ ...row })) };
  if (!todo.length) return output;
  const started = performance.now();
  const facts = new RustInventory(root, input, metrics);
  const session = new RustSession(facts, input, started + cfg.mutation.maxSeconds * 1000, metrics);
  try {
    await session.prepare();
    facts.assertFresh();
    const generated = new Map();
    for (const id of todo) {
      const row = mutation.mutants[byId.get(id)];
      if (!generated.has(row.source)) {
        const lines = new Set(input.sources[row.source]?.coverable?.split(',').flatMap((part) => {
          const [a, b = a] = part.split('-').map(Number);
          return Array.from({ length: b - a + 1 }, (_, i) => a + i);
        }) ?? []);
        generated.set(row.source, new Map((sourceSites(facts, row.source, lines)).map((site) => [site.id, site])));
      }
      const site = generated.get(row.source).get(id);
      if (!site || site.line !== row.line || site.operator !== row.operator)
        refuse('confirmation', `Rust mutant cannot be regenerated from pinned input: ${id}`);
      for (let rep = 0; rep < 2; rep++) {
        const result = await session.check(site);
        if (!result || result.invalid) refuse('confirmation-budget', `Rust mutant confirmation did not complete: ${id}`);
        if (result.status !== 'survived') {
          output.mutants[byId.get(id)] = entry(site, result);
          if (['error', 'timeout'].includes(result.status) && output.targeted?.length) {
            const model = mutationModel(input, cfg, output.targeted);
            output.targeted = output.targeted.filter((uid) => {
              const own = model.unitById.get(uid)?.own;
              return !own?.has(site.source) || !lineIn(own.get(site.source), site.line);
            });
          }
          log(`mutate-rust: confirmation changed ${id} to ${result.status}`);
          break;
        }
      }
    }
    facts.assertFresh();
    return output;
  } finally { session.close(); }
}

export { RustMutationError } from './errors.mjs';
