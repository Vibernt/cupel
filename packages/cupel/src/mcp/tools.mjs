// MCP tool contracts and the in-process bridge to the CLI command implementations.
import { main } from '../cli/main.mjs';
import { summaryLine } from '../cli/human.mjs';

const string = { type: 'string', minLength: 1 };
const paths = { input: string, baseInput: string, headInput: string, config: string };
const pages = {
  page: { type: 'integer', minimum: 1 },
  pageSize: { type: 'integer', minimum: 1, maximum: 200 },
};
const schema = (properties) => ({ type: 'object', properties, additionalProperties: false });

export const TOOLS = [
  {
    name: 'cupel_check',
    description: 'Before committing new or changed tests, review their evidence. Pass tests as test IDs or files. With no tests, check all collected units. Cupel never advises removing tests; no-unique-evidence means a person may review, never delete.',
    inputSchema: schema({ ...paths, tests: { type: 'array', items: string }, base: string }),
  },
  {
    name: 'cupel_report',
    description: 'Get the whole-suite picture: coverage, mutation, tiers and advice. Cupel never advises removing tests; no-unique-evidence means a person may review, never delete.',
    inputSchema: schema({ input: string, config: string, ...pages }),
  },
  {
    name: 'cupel_guard',
    description: 'Before removing or rewriting tests, compare the base with the working tree or saved inputs. With no base, compare HEAD. Cupel never advises removing tests; no-unique-evidence means a person may review, never delete.',
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
];

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
const own = (value, key) => Object.hasOwn(value, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Validate the parameter types before passing any argument to the CLI. */
export function validateCall(name, args) {
  const tool = byName.get(name);
  if (!tool) return `unknown tool ${JSON.stringify(name)}`;
  if (!object(args)) return 'arguments must be an object';
  const properties = tool.inputSchema.properties;
  for (const [key, value] of Object.entries(args)) {
    if (!own(properties, key)) return `unknown argument ${JSON.stringify(key)}`;
    if (['page', 'pageSize'].includes(key)) {
      if (!Number.isInteger(value) || value < 1 || (key === 'pageSize' && value > 200)) return `${key} must be a positive integer${key === 'pageSize' ? ' at most 200' : ''}`;
    } else if (key === 'tests') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) return 'tests must be an array of non-empty strings';
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
  const cmd = name.slice('cupel_'.length);
  const args = [cmd, '--json', '--quiet'];
  const option = (key, value) => { if (value !== undefined) args.push(`--${key}`, value); };
  option('config', p.config);
  if (cmd === 'guard') {
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
  if (cmd === 'guard') return `guard ${report.guard.pass ? 'passed' : 'failed'}; ${report.guard.checks.length} checks`;
  if (cmd === 'check') return `check ${exit === 1 ? 'failed' : 'passed'}; ${report.check.verdicts.length} verdicts`;
  if (cmd === 'plan') return `plan: ${report.plan.order.length} units, expected ${report.plan.expectedMs} ms`;
  const line = summaryLine(report.suite);
  return cmd === 'label' && exit === 1 ? `label failed: ${line}` : line;
}

export async function callTool(name, params, { root, env }) {
  const cmd = name.slice('cupel_'.length);
  let result;
  let stderr = '';
  const exit = await main(commandArgs(name, params), {
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
  const data = report === undefined ? { exit, error: stderr.trim() } :
    ['report', 'label'].includes(cmd) ? pageReport(report, params) : report;
  return {
    content: [
      { type: 'text', text: summary(cmd, report, exit, stderr).replaceAll('\n', ' ') },
      { type: 'text', text: JSON.stringify(data) },
    ],
    isError: exit === 2 || exit === 3,
  };
}
