// K14: one result per mutant when several runners test the same source.
//
// Each runner plants the same mutants in a source they share (same id), and runs them against its own tests. The
// rows are combined into one: caught if any runner's tests caught it, so a mutant survives only when no runner's
// covering tests notice it. A mutant that no runner caught and that some runner whose tests cover its line did not
// run (a sample or a time budget left it out) has no complete answer: it is left out and the result is `sampled`.

import { format, lines, union } from '../engine/lines.mjs';
import { cmp } from '../engine/order.mjs';
import { environment } from './errors.mjs';

/** Higher wins: a catch decides; a timeout is detected; an error is undecided; then a survivor; then no coverage. */
const RANK = { killed: 4, timeout: 3, error: 2, survived: 1, 'no-coverage': 0 };
const rank = (status) => RANK[status] ?? -1;

const holds = (value, line) => lines(value ?? '').some(([a, b]) => a <= line && line <= b);

/** Whether a runner's tests run `line` of `source`, by its per-test, setup or whole-file coverage. */
export function coversLine(part, source, line) {
  const coverage = part?.coverage ?? {};
  for (const index of [coverage.byTest, coverage.setup, coverage.byFile])
    for (const row of Object.values(index ?? {})) if (holds(row?.[source], line)) return true;
  return false;
}

/** The units of a runner whose own coverage runs `line` of `source`. */
function unitsCovering(part, source, line) {
  const out = new Set();
  for (const test of part?.tests ?? []) if (holds(part.coverage?.byTest?.[test.id]?.[source], line)) out.add(test.unit ?? test.id);
  return out;
}

/** One row from the rows several runners produced for the same mutant id. */
export function combineRows(rows) {
  if (rows.length === 1) return rows[0];
  const best = rows.reduce((a, b) => (rank(b.status) > rank(a.status) ? b : a));
  const { killedBy: _k, killKinds: _kk, durationMs: _d, reused: _r, basis: _b, ...rest } = rows[0];
  const out = { ...rest, status: best.status };
  // The rows that decided the status credit their tests (catchers; for a runner that credits timeouts, those too).
  const deciding = rows.filter((r) => r.status === best.status);
  const credited = [...new Set(deciding.flatMap((r) => r.killedBy ?? []))].sort(cmp);
  if (credited.length) out.killedBy = credited;
  const kinds = Object.assign({}, ...deciding.map((r) => r.killKinds ?? {}));
  if (Object.keys(kinds).length) out.killKinds = Object.fromEntries(Object.entries(kinds).sort(([a], [b]) => cmp(a, b)));
  // A total time only when every runner that ran the mutant measured it.
  const ran = rows.filter((r) => r.status !== 'no-coverage');
  if (ran.length && ran.every((r) => Number.isInteger(r.durationMs))) out.durationMs = ran.reduce((a, r) => a + r.durationMs, 0);
  if (rows.every((r) => r.reused)) out.reused = true;
  // A copied basis names one runner's selection; the combined row gets a fresh basis over every runner's tests.
  if (rows.every((r) => r.basis && r.basis === rows[0].basis)) out.basis = rows[0].basis;
  return out;
}

/**
 * Combines the mutation results of several runners (`[{ name, part, mutation }]`, in runner order) into one
 * mutation object, and returns which runners reported each mutant (for survivor confirmation).
 */
export function combineRunnerMutations(results) {
  const byId = new Map();
  for (const { name, mutation } of results)
    for (const row of mutation?.mutants ?? []) {
      if (!byId.has(row.id)) byId.set(row.id, []);
      byId.get(row.id).push({ name, row });
    }
  const owners = new Map();
  const mutants = [];
  const dropped = [];
  for (const [id, entries] of [...byId].sort(([a], [b]) => cmp(a, b))) {
    const first = entries[0].row;
    for (const { name, row: other } of entries)
      if (other.source !== first.source || other.line !== first.line || other.operator !== first.operator)
        throw environment(`runner ${name} reports mutant ${id} at ${other.source}:${other.line} (${other.operator}), another runner at ${first.source}:${first.line} (${first.operator})`);
    const row = combineRows(entries.map((e) => e.row));
    const reporting = new Set(entries.map((e) => e.name));
    // Only a runner whose input holds the source plants its mutants; one whose tests cover the line but that did not
    // report the mutant left it unanswered.
    const missing = row.status !== 'killed' && results.some(({ name, part }) => !reporting.has(name)
      && Object.hasOwn(part?.sources ?? {}, row.source) && coversLine(part, row.source, row.line));
    if (missing) { dropped.push(row); continue; }
    // Confirmation re-runs survivors with the runners whose tests ran the mutant, not those that only lacked coverage.
    const ran = entries.filter((e) => e.row.status !== 'no-coverage').map((e) => e.name);
    owners.set(id, ran.length ? [...new Set(ran)] : [...reporting]);
    mutants.push(row);
  }
  // A targeted unit is complete only if every mutant it covers has a complete answer.
  const incomplete = new Set(dropped.flatMap((row) => results.flatMap(({ part }) => [...unitsCovering(part, row.source, row.line)])));
  const targeted = [...new Set(results.flatMap(({ mutation }) => mutation?.targeted ?? []))].filter((u) => !incomplete.has(u)).sort(cmp);
  const merged = { mutants, targeted };
  const sampledFlags = results.map(({ mutation }) => mutation?.sampled).filter((s) => s !== undefined);
  if (sampledFlags.length || dropped.length) merged.sampled = dropped.length > 0 || sampledFlags.some(Boolean);
  const seeds = [...new Set(results.map(({ mutation }) => mutation?.seed).filter((n) => n !== undefined))];
  if (seeds.length === 1) merged.seed = seeds[0];
  return { mutation: merged, owners, dropped: dropped.map((r) => r.id) };
}

/**
 * The lines another runner's targeted units run, in the sources `part` holds, as a `changed` scope (line-set strings,
 * never empty: an empty string would mean the whole file). A targeted unit's mutants must also run against every other
 * runner whose tests cover them, or a mutant its runner did not catch could be reported surviving (K14).
 */
export function targetedLinesForOtherRunners(input, targeted, part) {
  const wanted = new Set(targeted ?? []);
  if (!wanted.size) return {};
  const own = new Set((part.tests ?? []).map((t) => t.unit ?? t.id));
  const out = {};
  for (const test of input.tests ?? []) {
    const unit = test.unit ?? test.id;
    if (!wanted.has(unit) || own.has(unit) || test.status !== 'passed') continue;
    for (const [source, value] of Object.entries(input.coverage?.byTest?.[test.id] ?? {})) {
      if (!Object.hasOwn(part.sources ?? {}, source)) continue;
      out[source] = union(out[source] ?? [], lines(value));
    }
  }
  return Object.fromEntries(Object.entries(out).filter(([, set]) => set.length).map(([source, set]) => [source, format(set)]));
}

/** Adds line sets to a `changed` scope; an existing empty string (the whole file) stays whole. */
export function addChanged(changed, extra) {
  const out = { ...(changed ?? {}) };
  for (const [source, value] of Object.entries(extra)) {
    if (out[source] === '') continue;
    out[source] = out[source] === undefined ? value : format(union(lines(out[source]), lines(value)));
  }
  return out;
}

/** Which runners hold a mutant, when no run recorded it: those whose tests cover its line, else those with its source. */
export function ownersFromParts(mutation, parts) {
  const owners = new Map();
  for (const row of mutation?.mutants ?? []) {
    let names = parts.filter(({ input }) => coversLine(input, row.source, row.line)).map((p) => p.name);
    if (!names.length) names = parts.filter(({ input }) => Object.hasOwn(input.sources ?? {}, row.source)).map((p) => p.name);
    owners.set(row.id, names);
  }
  return owners;
}
