// The analysed input: units (3.3), signals (S1-S6) and tiers (T1-T8). Pure.

import { cmp, sortedUnique } from './order.mjs';
import {
  lines, size, intersect, mapFrom, mapUnion, mapUnionAll, mapDiff, mapIntersect, mapSize, mapIsEmpty, mapFilter,
  exclusiveLines,
} from './lines.mjs';
import { anyGlobMatches, anyWordMatches } from './match.mjs';
import { unitOf } from './integrity.mjs';

const TIER_TAGS = ['critical', 'standard', 'minor']; // most protective first
const DETECTED = new Set(['killed', 'timeout']);

/** Median of a row's durations: the middle value, or the floored mean of the two middle ones (S4). */
export function median(values) {
  if (!values || values.length === 0) return 0;
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : Math.floor((v[mid - 1] + v[mid]) / 2);
}

/** Jaccard index of two sets given as arrays or Sets of primitives; 0 when both are empty. */
export function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  let both = 0;
  for (const x of A) if (B.has(x)) both++;
  const either = A.size + B.size - both;
  return either === 0 ? { num: 0, den: 0 } : { num: both, den: either };
}

/** Jaccard over line maps, as an exact fraction { num, den }. den 0 means both are empty. */
export function lineJaccard(a, b) {
  const both = mapSize(mapIntersect(a, b));
  return { num: both, den: mapSize(a) + mapSize(b) - both };
}

export function isCriticalSource(path, cfg) {
  return anyGlobMatches(cfg.tiers.critical, path, true) || anyWordMatches(cfg.words.path, path);
}

/**
 * Builds the model of one schema-valid, integrity-checked input.
 * `label` prefixes diagnostic messages when the command has two inputs.
 */
export function buildModel(input, cfg, label) {
  const diagnostics = [];
  const granularity = input.coverage.granularity;
  const fileLevel = granularity === 'file';

  // Sources and criticality.
  const sources = new Map();
  for (const path of Object.keys(input.sources).sort(cmp)) {
    const s = input.sources[path];
    sources.set(path, { coverable: lines(s.coverable), hash: s.hash, critical: isCriticalSource(path, cfg) });
  }
  const critical = (src) => sources.get(src)?.critical === true;

  // Setup lines per test file, and all setup lines.
  const setup = new Map();
  for (const [file, entry] of Object.entries(input.coverage.setup ?? {})) setup.set(file, mapFrom(entry));
  const allSetup = mapUnionAll(setup.values());
  const byFile = new Map();
  for (const [file, entry] of Object.entries(input.coverage.byFile ?? {})) byFile.set(file, mapFrom(entry));
  const byTest = new Map();
  for (const [id, entry] of Object.entries(input.coverage.byTest ?? {})) byTest.set(id, mapFrom(entry));

  // Every covered line: rows' coverage, file coverage and setup (G4, R3).
  const covered = mapUnionAll([...byTest.values(), ...byFile.values(), allSetup]);

  // Tests and units.
  const tests = new Map();
  const units = new Map();
  input.tests.forEach((t, index) => {
    tests.set(t.id, t);
    const id = unitOf(t);
    if (!units.has(id)) units.set(id, { id, file: t.file, rowTests: [] });
    units.get(id).rowTests.push(t);
    (t.tags ?? []).forEach((tag, j) => {
      if (!TIER_TAGS.includes(tag)) {
        diagnostics.push({
          code: 'unknown-tag', severity: 'error', path: `/tests/${index}/tags/${j}`, test: t.id,
          message: `${label ? `${label}: ` : ''}tag "${tag}" is not a tier tag (critical, standard, minor)`,
        });
      }
    });
  });

  const rechecked = new Set(input.coverage.rechecked ?? []);
  const mutation = input.mutation ?? null;
  const targeted = new Set(mutation?.targeted ?? []);
  const shapes = new Map(Object.entries(input.shapes ?? {}).map(([k, v]) => [k, new Set(v)]));

  const findings = new Map();
  for (const f of input.brittleness ?? []) {
    if (!findings.has(f.test)) findings.set(f.test, []);
    findings.get(f.test).push(f);
  }

  const list = [...units.values()].sort((a, b) => cmp(a.id, b.id));
  const rowUnit = new Map();
  for (const u of list) {
    u.rowTests.sort((a, b) => cmp(a.id, b.id));
    u.rows = u.rowTests.map((t) => t.id);
    for (const r of u.rows) rowUnit.set(r, u.id);
    const st = u.rowTests.map((t) => t.status);
    u.status = st.includes('failed') ? 'failed' : st.every((s) => s === 'skipped') ? 'skipped' : 'passed';
    u.e2e = u.rowTests.some((t) => t.kind === 'e2e');
    u.spawnsInterpreter = u.rowTests.some((t) => t.spawnsInterpreter === true);

    // S1. At file granularity the file's coverage stands in for each of its units (ENGINE-NOTES).
    const rowsCov = mapUnionAll(u.rows.map((r) => byTest.get(r) ?? new Map()));
    const raw = fileLevel ? mapUnion(rowsCov, byFile.get(u.file) ?? new Map()) : rowsCov;
    u.own = mapDiff(raw, setup.get(u.file) ?? new Map());
    u.ownLines = mapSize(u.own);

    // S4.
    const rowDurations = u.rowTests.map((t) => median(t.durationsMs));
    u.durationMs = rowDurations.reduce((a, b) => a + b, 0);
    u.runs = Math.min(...u.rowTests.map((t) => (t.durationsMs ?? []).length));

    // S5.
    const fs = u.rows.flatMap((r) => findings.get(r) ?? []);
    u.findings = fs;
    u.brittle = sortedUnique(fs.map((f) => f.kind));
    u.pinned = fs.some((f) => f.deliberate !== true);
    u.deliberatelyPinned = fs.length > 0 && fs.every((f) => f.deliberate === true);

    u.rechecked = rechecked.has(u.id);
    u.targeted = targeted.has(u.id);
    u.shape = shapes.get(u.id) ?? null;
  }

  // S2: unique lines, at test granularity only (A12).
  if (!fileLevel) {
    const exclusive = exclusiveLines(list.map((u) => u.own));
    list.forEach((u, i) => {
      u.unique = mapDiff(exclusive[i], allSetup);
      u.uniqueLines = mapSize(u.unique);
    });
  } else {
    for (const u of list) {
      u.unique = null;
      u.uniqueLines = null;
    }
  }

  // S3: kills.
  const mutants = (mutation?.mutants ?? []).map((m) => ({
    ...m,
    detected: DETECTED.has(m.status),
    critical: critical(m.source),
    killerUnits: new Set((m.killedBy ?? []).map((r) => rowUnit.get(r))),
  }));
  for (const u of list) {
    u.kills = 0;
    u.uniqueKills = fileLevel ? null : 0;
  }
  const byId = new Map(list.map((u) => [u.id, u]));
  for (const m of mutants) {
    if (!m.detected) continue;
    for (const uid of m.killerUnits) byId.get(uid).kills++;
    if (!fileLevel && m.killerUnits.size === 1) byId.get([...m.killerUnits][0]).uniqueKills++;
  }

  // T1-T8.
  for (const u of list) {
    Object.assign(u, tierOf(u, cfg, fileLevel, critical));
    u.critical = u.tier === 'critical';
    u.protected = u.critical || [...u.own.keys()].some(critical);
  }

  return {
    input, granularity, fileLevel, sources, critical, setup, allSetup, byFile, byTest, covered,
    tests, units: list, unitById: byId, rowUnit, mutation, mutants, diagnostics,
  };
}

function tierOf(u, cfg, fileLevel, critical) {
  const tags = new Set(u.rowTests.flatMap((t) => t.tags ?? []));
  for (const tier of TIER_TAGS) if (tags.has(tier)) return { tier, tierReason: 'tag' }; // T1
  if (anyGlobMatches(cfg.tiers.critical, u.file, true)) return { tier: 'critical', tierReason: 'path-rule' }; // T3
  if (anyWordMatches(cfg.words.path, u.file) || u.rowTests.some((t) => anyWordMatches(cfg.words.title, t.name))) {
    return { tier: 'critical', tierReason: 'critical-word' }; // T4
  }
  if (!fileLevel && !mapIsEmpty(mapFilter(u.unique, critical))) return { tier: 'critical', tierReason: 'unique-critical-lines' }; // T5
  if (anyGlobMatches(cfg.tiers.minor, u.file, false)) return { tier: 'minor', tierReason: 'path-rule' }; // T6
  return { tier: 'standard', tierReason: 'default' }; // T7
}

/** Covered and coverable line counts over the sources accepted by `keep`. */
export function coverageCounts(model, keep = () => true) {
  let covered = 0;
  let coverable = 0;
  for (const [path, s] of model.sources) {
    if (!keep(path)) continue;
    coverable += size(s.coverable);
    covered += size(intersect(model.covered.get(path) ?? [], s.coverable));
  }
  return { covered, coverable };
}
