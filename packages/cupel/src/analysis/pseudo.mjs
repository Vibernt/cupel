// S10a evidence only. This module has no I/O and does not change engine advice.
import { lines } from '../engine/lines.mjs';
import { cmp } from '../engine/order.mjs';

const expand = (value) => lines(value).flatMap(([start, end]) => Array.from({ length: end - start + 1 }, (_, k) => start + k));
const keyOf = (site) => site.functionKey ?? site.function_key;
const startOf = (site) => site.startLine ?? site.start_line;
const endOf = (site) => site.endLine ?? site.end_line;

export function analyzePseudo(input, sites) {
  const resultById = new Map((input.mutation?.mutants ?? []).map((m) => [m.id, m]));
  const groups = new Map();
  for (const site of sites.filter((s) => s.operator === 'body-replace')) {
    const key = keyOf(site);
    if (!groups.has(key)) groups.set(key, { id: key, source: site.source, name: site.functionName ?? site.function_name,
      startLine: startOf(site), endLine: endOf(site), variants: [] });
    groups.get(key).variants.push(site);
  }
  const functions = [];
  for (const fn of groups.values()) {
    const primary = fn.variants.find((s) => s.variant === 0);
    const first = resultById.get(primary?.id);
    const covered = input.tests.some((test) => test.status === 'passed' &&
      expand(input.coverage.byTest?.[test.id]?.[fn.source] ??
        (input.coverage.granularity === 'file' ? input.coverage.byFile?.[test.file]?.[fn.source] : '') ?? '')
        .some((line) => line >= fn.startLine && line <= fn.endLine));
    if (!covered) continue;
    const secondary = fn.variants.find((s) => s.variant === 1);
    const second = secondary ? resultById.get(secondary.id) : null;
    const tested = [first, second].some((m) => m && ['killed', 'timeout'].includes(m.status));
    const pseudoTested = first?.status === 'survived' && (!secondary || second?.status === 'survived');
    functions.push({ id: fn.id, source: fn.source, name: fn.name, startLine: fn.startLine,
      endLine: fn.endLine, status: tested ? 'tested' : pseudoTested ? 'pseudo-tested' : 'incomplete',
      mutants: [first, second].filter(Boolean).map((m) => m.id) });
  }
  functions.sort((a, b) => cmp(a.id, b.id));
  const units = new Map();
  for (const test of input.tests) {
    const id = test.unit ?? test.id;
    if (!units.has(id)) units.set(id, { id, tests: [], own: new Map() });
    const unit = units.get(id);
    unit.tests.push(test);
    const fileCoverage = input.coverage.granularity === 'file' ? input.coverage.byFile?.[test.file] : null;
    for (const [path, spec] of Object.entries({ ...fileCoverage, ...input.coverage.byTest?.[test.id] })) {
      if (!unit.own.has(path)) unit.own.set(path, new Set());
      for (const n of expand(spec)) unit.own.get(path).add(n);
    }
  }
  const rows = [];
  for (const unit of units.values()) {
    const setup = input.coverage.setup?.[unit.tests[0].file] ?? {};
    for (const [path, spec] of Object.entries(setup)) for (const n of expand(spec)) unit.own.get(path)?.delete(n);
    const touched = functions.filter((fn) => [...(unit.own.get(fn.source) ?? [])].some((n) => n >= fn.startLine && n <= fn.endLine));
    const pseudo = touched.filter((fn) => fn.status === 'pseudo-tested');
    const ownLines = [...unit.own.entries()].flatMap(([path, nums]) => [...nums].map((line) => ({ path, line })));
    const onlyPseudo = ownLines.length > 0 && ownLines.every(({ path, line }) => pseudo.some((fn) => fn.source === path && line >= fn.startLine && line <= fn.endLine));
    rows.push({ id: unit.id, coveredFunctions: touched.map((fn) => fn.id), pseudoTestedFunctions: pseudo.map((fn) => fn.id),
      pseudoShare: touched.length ? pseudo.length / touched.length : 0, pseudoTest: onlyPseudo });
  }
  rows.sort((a, b) => cmp(a.id, b.id));
  return { functions, pseudoTestedFunctions: functions.filter((fn) => fn.status === 'pseudo-tested'),
    testedFunctions: functions.filter((fn) => fn.status === 'tested'), units: rows,
    pseudoTests: rows.filter((unit) => unit.pseudoTest) };
}
