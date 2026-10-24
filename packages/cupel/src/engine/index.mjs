// The Cupel engine (cupel-spec/1): a pure function from command, inputs, config and arguments to
// a report and an exit code. No I/O, no clock, no randomness. See spec/SPEC.md and ENGINE-NOTES.md.

import { cmp } from './order.mjs';
import { effectiveConfig } from './config.mjs';
import { schemaDiagnostics, integrityDiagnostics, argumentDiagnostics, testArgumentDiagnostics } from './integrity.mjs';
import { buildModel } from './model.mjs';
import { advise, fileSummaries } from './advice.mjs';
import { suiteSection, unitEntry, planSection, checkSection, guardSection } from './commands.mjs';
import { orderKeys } from './keyorder.mjs';
import { tokens } from './match.mjs';

export const SPEC_VERSION = 'cupel-spec/1';
export const COMMANDS = Object.freeze(['report', 'plan', 'check', 'guard', 'label', 'validate']);

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_ENVIRONMENT = 3;

const diagnosticOrder = (a, b) =>
  cmp(a.code, b.code) || cmp(a.path ?? '', b.path ?? '') || cmp(a.test ?? '', b.test ?? '') || cmp(a.message ?? '', b.message ?? '');

function finish(schemas, base, extra, diagnostics, exit) {
  const sorted = [];
  const seen = new Set();
  for (const d of [...diagnostics].sort(diagnosticOrder)) {
    const key = JSON.stringify([d.code, d.severity, d.path, d.test, d.message]);
    if (!seen.has(key)) sorted.push(d);
    seen.add(key);
  }
  const report = { ...base, ...extra, diagnostics: sorted };
  return { report: orderKeys(schemas.report, schemas.report, report), exit };
}

/**
 * Runs one command.
 * @param {'report'|'plan'|'check'|'guard'|'label'|'validate'} command
 * @param {{ input?: object, base?: object, head?: object }} inputs
 * @param {object} config the parsed cupel.json, or {}
 * @param {{ changed?: object, tests?: string[], approvals?: object[], generatedAt?: string }} args
 * @param {{ input: object, config: object, report: object }} schemas
 * @returns {{ report: object, exit: number }}
 */
export function run(command, inputs = {}, config = {}, args = {}, schemas) {
  if (!COMMANDS.includes(command)) throw new TypeError(`unknown command: ${command}`);
  if (!schemas || !schemas.input || !schemas.config || !schemas.report) throw new TypeError('schemas.input, schemas.config and schemas.report are required');
  inputs = inputs ?? {};
  args = args ?? {};
  const base = { spec: SPEC_VERSION, kind: 'report', command };
  // After exit 2 or 3 only spec, kind, command and diagnostics are present (report schema).
  const stop = (diagnostics, exit) => finish(schemas, base, {}, diagnostics, exit);

  // Which documents this command reads.
  const docs = [];
  if (command === 'guard') {
    docs.push(['base', inputs.base], ['head', inputs.head]);
  } else if (command === 'check' && inputs.base !== undefined) {
    docs.push(['base', inputs.base], ['head', inputs.head ?? inputs.input]);
  } else {
    docs.push([null, inputs.input ?? inputs.head]);
  }
  const diagnostics = [];
  for (const [label, doc] of docs) {
    if (doc === undefined || doc === null) {
      diagnostics.push({ code: 'missing-input', severity: 'error', message: `${command} needs ${label ? `a ${label} input` : 'an input'}` });
    }
  }
  // I1
  diagnostics.push(...schemaDiagnostics(schemas.config, config ?? {}, 'invalid-config', null));
  diagnostics.push(...emptyWordDiagnostics(config ?? {}));
  for (const [label, doc] of docs) {
    if (doc !== undefined && doc !== null) diagnostics.push(...schemaDiagnostics(schemas.input, doc, 'invalid-input', label));
  }
  diagnostics.push(...argumentDiagnostics(command, args));
  if (diagnostics.length) return stop(diagnostics, EXIT_USAGE);

  // I2, I3
  for (const [label, doc] of docs) diagnostics.push(...integrityDiagnostics(doc, label));
  if (command === 'check') {
    const [label, head] = docs[docs.length - 1];
    diagnostics.push(...testArgumentDiagnostics(head, args.tests, label));
  }
  if (diagnostics.length) return stop(diagnostics, EXIT_USAGE);

  // G1
  if (command === 'guard') {
    const [b, h] = [inputs.base.runtime, inputs.head.runtime];
    const baseRuntimes = inputs.base.runtimes;
    const headRuntimes = inputs.head.runtimes;
    const mismatch = baseRuntimes && headRuntimes
      ? headRuntimes.map((r) => [baseRuntimes.find((x) => x.runner === r.runner), r]).find(([x, y]) => x && (x.name !== y.name || x.version !== y.version))
      : (b.name !== h.name || b.version !== h.version ? [b, h] : null);
    if (mismatch) {
      const [before, after] = mismatch;
      return stop([{
        code: 'runtime-mismatch', severity: 'error',
        message: `${after.runner ? `runner ${after.runner}: ` : ''}base ran on ${before.name} ${before.version}, head on ${after.name} ${after.version}; guard never compares across runtimes`,
      }], EXIT_ENVIRONMENT);
    }
  }

  const cfg = effectiveConfig(config ?? {}, schemas.config);
  const models = docs.map(([label, doc]) => {
    const m = buildModel(doc, cfg, label);
    m.groups = advise(m, cfg).groups;
    return m;
  });
  for (const m of models) diagnostics.push(...m.diagnostics);
  const head = models[models.length - 1];

  const out = {};
  if (args.generatedAt !== undefined) out.generatedAt = args.generatedAt;
  out.runtime = { name: head.input.runtime.name, version: head.input.runtime.version };
  if (head.input.runtimes) out.runtimes = head.input.runtimes.map(({ runner, name, version }) => ({ runner, name, version }));
  const analysis = () => {
    out.suite = suiteSection(head);
    out.units = head.units.map(unitEntry);
    out.groups = head.groups;
    const files = fileSummaries(head);
    if (files) out.files = files;
  };

  let exit = EXIT_OK;
  switch (command) {
    case 'validate':
      break;
    case 'report':
      analysis();
      break;
    case 'label':
      analysis();
      if (diagnostics.some((d) => d.code === 'unknown-tag')) exit = EXIT_FAILED; // T2, L1
      break;
    case 'plan':
      analysis();
      out.plan = planSection(head, args.changed);
      break;
    case 'check': {
      analysis();
      const r = checkSection(head, models.length === 2 ? models[0] : null, args.tests);
      out.check = r.section;
      exit = r.exit;
      break;
    }
    case 'guard': {
      const r = guardSection(models[0], head, cfg, args.approvals ?? []);
      out.guard = r.section;
      exit = r.exit;
      break;
    }
  }
  return finish(schemas, base, out, diagnostics, exit);
}

/** I1: a tier word with no tokens would match every path, so it is an invalid config. */
function emptyWordDiagnostics(config) {
  const out = [];
  for (const key of ['pathWords', 'titleWords', 'extraPathWords', 'extraTitleWords']) {
    const words = config?.tiers?.[key];
    if (!Array.isArray(words)) continue;
    words.forEach((w, i) => {
      if (typeof w === 'string' && tokens(w).length === 0) {
        out.push({ code: 'invalid-config', severity: 'error', path: `/tiers/${key}/${i}`, message: `word ${JSON.stringify(w)} has no letters or digits` });
      }
    });
  }
  return out;
}
