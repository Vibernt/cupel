// MCP tool contracts and the in-process bridge to the CLI command implementations.
import { main } from '../cli/main.mjs';
import { summaryLine } from '../cli/human.mjs';
import { SnapshotError } from './report-snapshots.mjs';

const string = { type: 'string', minLength: 1 };
const paths = { input: string, baseInput: string, headInput: string, config: string };
const pages = {
  page: { type: 'integer', minimum: 1 },
  pageSize: { type: 'integer', minimum: 1, maximum: 200 },
};
const schema = (properties) => ({ type: 'object', properties, additionalProperties: false });
const prPins = { profile: { enum: ['node-readonly-files-v2'] }, base: string,
  producerSha256: string, workDir: string, out: string, node: string,
  inputPolicy: { enum: ['strict-v1', 'express-root-npmrc-opaque-v1'] } };
const prRequired = ['profile', 'base', 'producerSha256', 'workDir', 'out'];

export const TOOLS = [
  {
    name: 'cupel_check',
    description: 'Before committing new or changed tests, review their evidence. Pass tests as test IDs or files. With no tests, check all collected units. Cupel never advises removing tests; no-unique-evidence means a person may review, never delete.',
    inputSchema: schema({ ...paths, tests: { type: 'array', items: string }, base: string }),
  },
  {
    name: 'cupel_report',
    description: 'Get the whole-suite picture: coverage, mutation, tiers and advice. First-release core is JS/TS/Python; bounded Go/Ruby/Rust are previews. Set retain:true to save a historical report for page replay with snapshotId; ordinary calls remain fresh. Cupel never advises removing tests; no-unique-evidence means a person may review, never delete.',
    inputSchema: schema({ input: string, config: string, ...pages, retain: { type: 'boolean' }, snapshotId: string }),
  },
  {
    name: 'cupel_review',
    description: 'Before deleting or merging tests: get evidence per candidate, read the test code, propose a change, then run cupel_guard; Cupel never advises removal.',
    inputSchema: schema({ input: string, config: string, units: { type: 'array', items: string }, limit: { type: 'integer', minimum: 0 }, assertions: string }),
  },
  {
    name: 'cupel_guard',
    description: 'Before removing or rewriting tests, compare the base with the working tree or saved inputs. First-release core is JS/TS/Python full guard; bounded Go/Ruby/Rust are previews. With no base, compare HEAD. Cupel never advises removing tests; no-unique-evidence means a person may review, never delete.',
    inputSchema: schema({ ...paths, base: string, approvals: { anyOf: [string, { type: 'array', items: { type: 'object', properties: { action: { enum: ['remove', 'downgrade'] }, id: string, by: string }, required: ['action', 'id', 'by'], additionalProperties: false } }] } }),
  },
  {
    name: 'cupel_plan',
    description: 'Choose what to run first: critical and changed tests before the rest. Cupel never advises removing tests; no-unique-evidence means a person may review, never delete.',
    inputSchema: schema({ input: string, config: string, changed: string }),
  },
  {
    name: 'cupel_label',
    description: 'Inspect test tiers and why each tier applies. Cupel never advises removing tests; no-unique-evidence means a person may review, never delete.',
    inputSchema: schema({ input: string, config: string, ...pages }),
  },
  {
    name: 'cupel_pr_producer',
    description: 'Private experiment outside the supported first release: inspect the Node selective-profile producer pin. An operator must approve and retain this pin in trusted storage; prepare and PR execution never select their own trusted pin. Cupel never advises removing tests.',
    inputSchema: schema({}),
  },
  {
    name: 'cupel_pr_prepare',
    description: 'Private experiment outside the supported first release: explicitly opt into node-readonly-files-v2 on Node 26.7.0. Prepare a complete sealed baseline at an exact committed Git tree; workDir and out must be outside the subject. Keep the artifact and its returned pin outside the proposing agent write scope. Unsupported suites refuse. Cupel never advises removing tests.',
    inputSchema: { ...schema({ ...prPins, config: string }), required: prRequired },
  },
  {
    name: 'cupel_pr',
    description: 'Private experiment outside the supported first release: execute a scoped Node 26 PR check against an independently pinned baseline. Reports executed and unexecuted files and complete request cost; wholeGuardPass is always false. Ordinary full guard remains separate. Unsupported or stale evidence refuses; no automatic alternate mode. Cupel never advises removing tests.',
    inputSchema: { ...schema({ ...prPins, baseline: string, baselineSha256: string }),
      required: [...prRequired, 'baseline', 'baselineSha256'] },
  },
];

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
const own = (value, key) => Object.hasOwn(value, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Validate the parameter types before passing any argument to the CLI. */
export function validateCall(name, args) {
  const tool = byName.get(name);
  if (!tool) return `unknown tool ${JSON.stringify(name)}`;
  if (!object(args)) return 'arguments must be an object';
  for (const required of tool.inputSchema.required ?? [])
    if (!own(args, required)) return `${required} is required`;
  if (name === 'cupel_report' && own(args, 'snapshotId')) {
    for (const key of Object.keys(args)) {
      if (!['snapshotId', 'page', 'pageSize'].includes(key)) return `snapshotId replay accepts only snapshotId, page and pageSize; ${JSON.stringify(key)} is an execution argument`;
    }
  }
  const properties = tool.inputSchema.properties;
  for (const [key, value] of Object.entries(args)) {
    if (!own(properties, key)) return `unknown argument ${JSON.stringify(key)}`;
    if (properties[key].enum && !properties[key].enum.includes(value))
      return `${key} must be ${properties[key].enum.join(' or ')}`;
    if (['page', 'pageSize'].includes(key)) {
      if (!Number.isInteger(value) || value < 1 || (key === 'pageSize' && value > 200)) return `${key} must be a positive integer${key === 'pageSize' ? ' at most 200' : ''}`;
    } else if (key === 'retain') {
      if (typeof value !== 'boolean') return 'retain must be a boolean';
    } else if (key === 'tests' || key === 'units') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) return `${key} must be an array of non-empty strings`;
    } else if (key === 'limit') {
      if (!Number.isSafeInteger(value) || value < 0) return 'limit must be a nonnegative safe integer';
    } else if (key === 'approvals') {
      if (typeof value === 'string' && value) continue;
      if (!Array.isArray(value) || value.some((item) => !object(item) || !['remove', 'downgrade'].includes(item.action)
        || typeof item.id !== 'string' || !item.id || typeof item.by !== 'string' || !item.by
        || Object.keys(item).some((field) => !['action', 'id', 'by'].includes(field)))) return 'approvals must be a path or a list of { action, id, by }';
    } else if (typeof value !== 'string' || !value) return `${key} must be a non-empty string`;
  }
  if (own(args, 'input') && own(args, 'headInput')) return 'use either input or headInput';
  if (own(args, 'base') && own(args, 'baseInput')) return 'use either base or baseInput';
  return null;
}

function commandArgs(name, p) {
  const cmd = name.slice('cupel_'.length).replaceAll('_', '-');
  const args = [cmd, '--json', '--quiet'];
  const option = (key, value) => { if (value !== undefined) args.push(`--${key}`, value); };
  option('config', p.config);
  if (cmd === 'pr' || cmd === 'pr-prepare') {
    for (const [key, value] of Object.entries({ profile: p.profile, base: p.base,
      'producer-sha256': p.producerSha256, 'work-dir': p.workDir, out: p.out,
      node: p.node, 'input-policy': p.inputPolicy, baseline: p.baseline,
      'baseline-sha256': p.baselineSha256 })) option(key, value);
  } else if (cmd === 'guard') {
    option('base', p.base ?? (p.baseInput === undefined ? 'HEAD' : undefined));
    option('base-input', p.baseInput);
    option('head-input', p.headInput ?? p.input);
    if (typeof p.approvals === 'string') option('approvals', p.approvals);
  } else if (cmd === 'check') {
    option('input', p.input);
    option('head-input', p.headInput);
    option('base', p.base);
    option('base-input', p.baseInput);
    args.push(...(p.tests ?? []));
  } else {
    option('input', p.input);
    if (cmd === 'plan') option('changed', p.changed);
    if (cmd === 'review') {
      for (const unit of p.units ?? []) option('units', unit);
      option('limit', p.limit === undefined ? undefined : String(p.limit));
      option('assertions', p.assertions);
    }
  }
  return args;
}

function pageReport(report, p) {
  if (!Array.isArray(report.units)) return report;
  const page = p.page ?? 1;
  const size = p.pageSize ?? 50;
  return {
    ...(report.runtimes ? { runtime: report.runtime, runtimes: report.runtimes } : {}),
    suite: report.suite,
    units: report.units.slice((page - 1) * size, page * size),
    groups: report.groups,
    page,
    pages: Math.ceil(report.units.length / size),
  };
}

function summary(cmd, report, exit, error) {
  if (!report) return `${cmd}: ${error.trim().split('\n')[0] || `failed (exit ${exit})`}`;
  if (exit >= 2) return `${cmd}: ${report.diagnostics?.[0]?.message ?? `failed (exit ${exit})`}`;
  if (cmd === 'pr-producer') return `selective profile producer ${report.producerHash}; retain in trusted storage`;
  if (cmd === 'pr-prepare') return `prepared selective baseline ${report.artifact.sha256}; ${report.costs.totalMs} ms`;
  if (cmd === 'pr') return `scoped PR ${exit === 0 ? 'passed' : 'failed'} (${report.route}); ${report.executedFiles.length} files executed; ${report.costs.requestMs} ms; wholeGuardPass=false`;
  if (cmd === 'guard') return `guard ${report.guard.pass ? 'passed' : 'failed'}; ${report.guard.checks.length} checks`;
  if (cmd === 'check') return `check ${exit === 1 ? 'failed' : 'passed'}; ${report.check.verdicts.length} verdicts`;
  if (cmd === 'plan') return `plan: ${report.plan.order.length} units, expected ${report.plan.expectedMs} ms`;
  if (cmd === 'review') return `review: ${report.review.candidates.length} candidates (${report.review.critical} critical); read code, then run cupel_guard`;
  const line = summaryLine(report.suite);
  return cmd === 'label' && exit === 1 ? `label failed: ${line}` : line;
}

function snapshotFailure(cause) {
  const message = `${cause.message}; call cupel_report without snapshotId for a fresh report`;
  return {
    content: [
      { type: 'text', text: `report snapshot error: ${message}` },
      { type: 'text', text: JSON.stringify({ error: { code: cause.code, message } }) },
    ],
    isError: true,
  };
}

const snapshotMetadata = (snapshotId, replay) => ({ snapshotId,
  snapshot: { kind: 'report', replay, historical: true } });

export async function callTool(name, params, { root, env, reportSnapshots, executeMain = main }) {
  const cmd = name.slice('cupel_'.length).replaceAll('_', '-');
  if (cmd === 'report' && own(params, 'snapshotId')) {
    try {
      if (!reportSnapshots) throw new SnapshotError('unavailable', 'report snapshots are unavailable in this server context');
      const { report, exit } = reportSnapshots.get(params.snapshotId, root);
      return {
        content: [
          { type: 'text', text: `historical report replay; ${summary(cmd, report, exit, '')}` },
          { type: 'text', text: JSON.stringify({ ...pageReport(report, params), ...snapshotMetadata(params.snapshotId, true) }) },
        ],
        isError: false,
      };
    } catch (cause) {
      if (cause instanceof SnapshotError) return snapshotFailure(cause);
      throw cause;
    }
  }
  let result;
  let stderr = '';
  const exit = await executeMain(commandArgs(name, params), {
    cwd: root,
    env,
    out: () => {},
    err: (chunk) => { stderr += chunk; },
    colour: false,
    result: (value) => { result = value; },
    strictDependencies: true,
    allTests: cmd === 'check' && params.tests === undefined,
    approvals: Array.isArray(params.approvals) ? params.approvals : undefined,
  });
  const report = result?.report;
  let data = report === undefined ? { exit, error: stderr.trim() } :
    ['report', 'label'].includes(cmd) ? pageReport(report, params) : report;
  let line = summary(cmd, report, exit, stderr).replaceAll('\n', ' ');
  if (cmd === 'report' && params.retain === true && (exit === 0 || exit === 1)) {
    try {
      if (!reportSnapshots) throw new SnapshotError('unavailable', 'report snapshots are unavailable in this server context');
      const snapshotId = reportSnapshots.put(report, exit);
      data = { ...data, ...snapshotMetadata(snapshotId, false) };
      line = `saved historical report; ${line}`;
    } catch (cause) {
      if (cause instanceof SnapshotError) return snapshotFailure(cause);
      throw cause;
    }
  }
  return {
    content: [
      { type: 'text', text: line },
      { type: 'text', text: JSON.stringify(data) },
    ],
    isError: exit === 2 || exit === 3,
  };
}
