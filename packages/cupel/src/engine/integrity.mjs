// Input integrity: I1 (schemas), I2 (references), I3 (lines), and argument checks. Pure.
//
// Diagnostic paths are JSON pointers into the document named in the message. When a command
// takes two inputs (guard, check against a base), the message starts with "base:" or "head:".

import { validate } from './schema.mjs';
import { parse, diff, format } from './lines.mjs';

const ptr = (...parts) => '/' + parts.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');

const diag = (code, fields) => ({ code, severity: 'error', ...fields });

const say = (label, message) => (label ? `${label}: ${message}` : message);

/** I1 for one document. `code` is invalid-input or invalid-config. */
export function schemaDiagnostics(schema, value, code, label) {
  return validate(schema, value).map((e) => diag(code, { path: e.path, message: say(label, e.message) }));
}

/** The unit id of each test: its `unit`, or its own id (3.3). */
export const unitOf = (t) => t.unit ?? t.id;

/** I2 and I3 for one schema-valid input. */
export function integrityDiagnostics(input, label) {
  const out = [];
  if (input.collection?.shard && input.collection?.subset) out.push(diag('invalid-input', { path: '/collection/subset', message: say(label, 'subset and shard cannot coexist') }));
  if (input.collection?.shard && input.collection.shard.index > input.collection.shard.total) out.push(diag('invalid-input', { path: '/collection/shard/index', message: say(label, 'shard index exceeds total') }));
  const testIds = new Set();
  const unitIds = new Set();
  const unitFile = new Map();
  const runners = input.runtimes && new Set();
  input.runtimes?.forEach((runtime, i) => {
    if (runners.has(runtime.runner)) out.push(diag('unknown-runner', { path: ptr('runtimes', i, 'runner'), message: say(label, `runner "${runtime.runner}" is listed more than once`) }));
    runners.add(runtime.runner);
  });

  // I2: unique ids, rows of a unit share a file.
  input.tests.forEach((t, i) => {
    if (runners && !runners.has(t.runner)) out.push(diag('unknown-runner', { path: ptr('tests', i, 'runner'), test: t.id, message: say(label, `test runner "${t.runner ?? ''}" is not in runtimes`) }));
    if (testIds.has(t.id)) {
      out.push(diag('duplicate-test', { path: ptr('tests', i, 'id'), test: t.id, message: say(label, `test id "${t.id}" is listed more than once`) }));
    }
    testIds.add(t.id);
    const u = unitOf(t);
    unitIds.add(u);
    if (!unitFile.has(u)) unitFile.set(u, t.file);
    else if (unitFile.get(u) !== t.file) {
      out.push(diag('unit-spans-files', {
        path: ptr('tests', i, 'file'), test: t.id,
        message: say(label, `unit "${u}" has rows in "${unitFile.get(u)}" and "${t.file}"`),
      }));
    }
  });

  const unknownTest = (id, path) =>
    out.push(diag('unknown-test', { path, test: id, message: say(label, `test id "${id}" is not in tests`) }));
  const unknownUnit = (id, path) =>
    out.push(diag('unknown-unit', { path, test: id, message: say(label, `unit "${id}" is not a unit`) }));

  const cov = input.coverage;
  for (const id of Object.keys(cov.byTest ?? {})) if (!testIds.has(id)) unknownTest(id, ptr('coverage', 'byTest', id));
  (cov.rechecked ?? []).forEach((id, i) => unitIds.has(id) || unknownUnit(id, ptr('coverage', 'rechecked', i)));
  const mut = input.mutation;
  if (mut) {
    mut.mutants.forEach((m, i) =>
      (m.killedBy ?? []).forEach((id, j) => testIds.has(id) || unknownTest(id, ptr('mutation', 'mutants', i, 'killedBy', j))),
    );
    (mut.targeted ?? []).forEach((id, i) => unitIds.has(id) || unknownUnit(id, ptr('mutation', 'targeted', i)));
    // Mutant ids are unique (3.5). Guard and check match mutants by id, so a duplicate is refused.
    const seen = new Set();
    mut.mutants.forEach((m, i) => {
      if (seen.has(m.id)) {
        out.push(diag('duplicate-mutant', { path: ptr('mutation', 'mutants', i, 'id'), message: say(label, `mutant id "${m.id}" is listed more than once`) }));
      }
      seen.add(m.id);
    });
  }
  (input.brittleness ?? []).forEach((b, i) => testIds.has(b.test) || unknownTest(b.test, ptr('brittleness', i, 'test')));
  for (const id of Object.keys(input.shapes ?? {})) if (!unitIds.has(id)) unknownUnit(id, ptr('shapes', id));

  // I3: ranges and coverable lines.
  const coverable = new Map();
  for (const [src, s] of Object.entries(input.sources)) {
    const p = parse(s.coverable);
    for (const [a, b] of p.bad) {
      out.push(diag('bad-range', { path: ptr('sources', src, 'coverable'), message: say(label, `range ${a}-${b} has start > end`) }));
    }
    coverable.set(src, p.set);
  }
  const checkEntry = (entry, base, test) => {
    for (const [src, text] of Object.entries(entry)) {
      const path = ptr(...base, src);
      const p = parse(text);
      for (const [a, b] of p.bad) {
        out.push(diag('bad-range', { path, ...(test ? { test } : {}), message: say(label, `range ${a}-${b} has start > end`) }));
      }
      if (!coverable.has(src)) {
        out.push(diag('unknown-source', { path, ...(test ? { test } : {}), message: say(label, `source "${src}" is not in sources`) }));
        continue;
      }
      const extra = diff(p.set, coverable.get(src));
      if (extra.length) {
        out.push(diag('line-not-coverable', {
          path, ...(test ? { test } : {}),
          message: say(label, `lines ${format(extra)} of "${src}" are not coverable`),
        }));
      }
    }
  };
  for (const [id, entry] of Object.entries(cov.byTest ?? {})) checkEntry(entry, ['coverage', 'byTest', id], id);
  for (const [file, entry] of Object.entries(cov.byFile ?? {})) checkEntry(entry, ['coverage', 'byFile', file]);
  for (const [file, entry] of Object.entries(cov.setup ?? {})) checkEntry(entry, ['coverage', 'setup', file]);
  if (mut) {
    mut.mutants.forEach((m, i) => {
      if (!coverable.has(m.source)) {
        out.push(diag('unknown-source', { path: ptr('mutation', 'mutants', i, 'source'), message: say(label, `source "${m.source}" is not in sources`) }));
      } else if (diff([[m.line, m.line]], coverable.get(m.source)).length > 0) {
        out.push(diag('line-not-coverable', {
          path: ptr('mutation', 'mutants', i, 'line'),
          message: say(label, `line ${m.line} of "${m.source}" is not coverable`),
        }));
      }
    });
  }
  return out;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmptyString = (v) => typeof v === 'string' && v.length > 0;

/** Checks the arguments a command uses (3.7). Unused arguments are ignored. */
export function argumentDiagnostics(command, args) {
  const out = [];
  const bad = (path, message) => out.push(diag('invalid-arguments', { path, message }));
  if (!isObject(args)) {
    bad('', 'arguments must be an object');
    return out;
  }
  if (args.generatedAt !== undefined && typeof args.generatedAt !== 'string') bad('/generatedAt', 'must be a string');
  if ((command === 'plan' || command === 'check') && args.changed !== undefined) {
    if (!isObject(args.changed)) bad('/changed', 'must be an object of path to line set');
    else {
      for (const [path, text] of Object.entries(args.changed)) {
        const p = parse(text);
        if (p.malformed) bad(ptr('changed', path), 'must be a line set');
        for (const [a, b] of p.bad) {
          out.push(diag('bad-range', { path: ptr('changed', path), message: `argument changed: range ${a}-${b} has start > end` }));
        }
      }
    }
  }
  if (command === 'check') {
    if (!Array.isArray(args.tests) || args.tests.length === 0) {
      out.push(diag('missing-argument', { path: '/tests', message: 'check needs a non-empty list of units or test ids' }));
    } else {
      args.tests.forEach((t, i) => nonEmptyString(t) || bad(ptr('tests', i), 'must be a non-empty string'));
    }
  }
  if (command === 'review') {
    if (args.units !== undefined) {
      if (!Array.isArray(args.units)) bad('/units', 'must be an array of unit ids, row ids or test files');
      else args.units.forEach((u, i) => nonEmptyString(u) || bad(ptr('units', i), 'must be a non-empty string'));
    }
    if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 0)) bad('/limit', 'must be a nonnegative safe integer');
  }
  if (command === 'guard' && args.approvals !== undefined) {
    if (!Array.isArray(args.approvals)) bad('/approvals', 'must be an array');
    else {
      args.approvals.forEach((a, i) => {
        if (!isObject(a)) return bad(ptr('approvals', i), 'must be an object');
        if (a.action !== 'remove' && a.action !== 'downgrade') bad(ptr('approvals', i, 'action'), 'must be "remove" or "downgrade"');
        if (!nonEmptyString(a.id)) bad(ptr('approvals', i, 'id'), 'must be a non-empty string');
        if (!nonEmptyString(a.by)) bad(ptr('approvals', i, 'by'), 'must name the person who approved (L5)');
      });
    }
  }
  return out;
}

/** I2 for argument `tests`: each must be a unit id or a test id of the input. */
export function testArgumentDiagnostics(input, tests, label) {
  const testIds = new Set(input.tests.map((t) => t.id));
  const unitIds = new Set(input.tests.map(unitOf));
  const out = [];
  tests.forEach((t, i) => {
    if (!testIds.has(t) && !unitIds.has(t)) {
      out.push(diag('unknown-test', { test: t, message: say(label, `argument tests[${i}]: "${t}" is neither a test id nor a unit`) }));
    }
  });
  return out;
}

