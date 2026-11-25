// Pure selection for Go faults. Coverage decides which tests may observe a line;
// setup/file coverage expands to every test in that package because it cannot be
// attributed more narrowly.

import { cmp } from '../engine/order.mjs';
import { lines as parseLines } from '../engine/lines.mjs';
import { refuse } from './errors.mjs';

const covers = (value, line) => parseLines(value ?? '').some(([a, b]) => a <= line && line <= b);
const escaped = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** An anchored Go `-run` expression selecting only these top-level names. */
export function goRunRegex(names) {
  const unique = [...new Set(names)].sort(cmp);
  if (!unique.length) throw new TypeError('goRunRegex needs at least one test name');
  return unique.length === 1 ? `^${escaped(unique[0])}$` : `^(?:${unique.map(escaped).join('|')})$`;
}

/** Tests and packages whose recorded coverage can observe `site`. */
export function selectGoTests(input, inventory, site) {
  const selected = new Map();
  const byId = new Map(input.tests.map((test) => [test.id, test]));
  for (const test of input.tests)
    if (covers(input.coverage.byTest?.[test.id]?.[site.source], site.line)) selected.set(test.id, test);

  for (const index of [input.coverage.setup, input.coverage.byFile]) {
    for (const [file, row] of Object.entries(index ?? {})) {
      if (!covers(row?.[site.source], site.line)) continue;
      const pkg = inventory.testPkg.get(file);
      if (!pkg) refuse('inventory', `coverage for ${file} cannot be mapped to a Go test package`);
      for (const test of inventory.testsByPackage.get(pkg) ?? []) selected.set(test.id, byId.get(test.id));
    }
  }

  const packages = new Map();
  for (const test of selected.values()) {
    const pkg = inventory.testPkg.get(test.file);
    if (!pkg) refuse('inventory', `Go test has no package: ${test.id}`);
    if (!packages.has(pkg)) packages.set(pkg, { pkg, tests: [], names: new Set() });
    packages.get(pkg).tests.push(test);
    packages.get(pkg).names.add(test.name);
  }
  for (const group of packages.values()) group.tests.sort((a, b) => cmp(a.id, b.id));
  return { tests: [...selected.values()].sort((a, b) => cmp(a.id, b.id)), packages };
}

/** Test files the shared K15 basis includes for this line (mirrors ReuseBasis.running). */
export function goBasisFiles(input, site) {
  const passed = input.tests.filter((test) => test.status === 'passed');
  const passedFiles = new Set(passed.map((test) => test.file));
  const files = new Set(passed
    .filter((test) => covers(input.coverage.byTest?.[test.id]?.[site.source], site.line))
    .map((test) => test.file));
  for (const index of [input.coverage.setup, input.coverage.byFile])
    for (const [file, row] of Object.entries(index ?? {}))
      if (passedFiles.has(file) && covers(row?.[site.source], site.line)) files.add(file);
  return files;
}

/**
 * Go compiles every _test.go file in each selected package, even with exact
 * `-run`. Reuse is valid only when K15 includes all of those compiled files.
 */
export function goReuseBasisValid(input, inventory, site) {
  const selection = selectGoTests(input, inventory, site);
  if (!selection.packages.size) return true; // no-coverage does not compile anything
  if (selection.tests.some((test) => test.status !== 'passed')) return false;
  const compiled = new Set([inventory.sourcePkg.get(site.source), ...selection.packages.keys()]);
  const basisFiles = goBasisFiles(input, site);
  return input.tests.every((test) => !compiled.has(inventory.testPkg.get(test.file)) || basisFiles.has(test.file));
}

