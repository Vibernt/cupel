// The cupel command line (DESIGN-M3.md, "CLI"). Parses arguments with node:util parseArgs, reads or
// collects inputs, runs the pure engine and prints its report. No network, no dependencies.

import { parseArgs } from 'node:util';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, relative, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, SPEC_VERSION } from '../engine/index.mjs';
import { effectiveConfig } from '../engine/config.mjs';
import { validate as schemaValidate } from '../engine/schema.mjs';
import { cmp } from '../engine/order.mjs';
import { match } from '../conformance/match.mjs';
import { CliError, EXIT_OK, EXIT_FAILED, EXIT_USAGE, EXIT_ENV, usage, environment } from './errors.mjs';
import { loadSchemas, readJson, writeJson, projectRoot, loadConfig } from './context.mjs';
import { checkRef, changedLines } from './git.mjs';
import { loadModule, requireCollector, collectTree, collectRef, mutate, confirm, lostSurvivors, mergeMutation } from './collect.mjs';
import { formatReport } from './human.mjs';
import { junitToInput } from './junit.mjs';
import { XmlError } from './xml.mjs';

export const FIXTURES_DIR = fileURLToPath(new URL('../../../../spec/conformance/adapters/', import.meta.url));

const COMMON = {
  config: { type: 'string' },
  json: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
};
const S = { type: 'string' };
const B = { type: 'boolean' };

const COMMANDS = {
  report: {
    usage: 'cupel report [--input <file>] [--evidence] [--no-mutation] [--runs N] [--out <file>] [--generated-at <text>]',
    about: 'score every test and give advice',
    options: { input: S, out: S, evidence: B, 'no-mutation': B, runs: S, 'generated-at': S },
  },
  check: {
    usage: 'cupel check <test ids or files...> [--base <ref> | --base-input <file>] [--input <file>] [--no-mutation] [--runs N]',
    about: 'does a new or changed test add anything?',
    options: { input: S, 'head-input': S, 'base-input': S, base: S, out: S, 'no-mutation': B, runs: S, 'generated-at': S },
    positionals: true,
  },
  guard: {
    usage: 'cupel guard (--base <ref> | --base-input <file>) [--head-input <file>] [--approvals <file>] [--no-mutation] [--runs N]',
    about: 'fail if coverage or critical mutation score falls',
    options: { base: S, 'base-input': S, 'head-input': S, approvals: S, 'no-mutation': B, runs: S, 'generated-at': S },
  },
  plan: {
    usage: 'cupel plan [--changed <ref> | --changed-lines <file>] [--input <file>] [--runs N]',
    about: 'priority order for a run',
    options: { input: S, changed: S, 'changed-lines': S, out: S, runs: S, 'generated-at': S },
  },
  label: {
    usage: 'cupel label [--input <file>] [--runs N]',
    about: 'show and check tiers',
    options: { input: S, out: S, runs: S, 'generated-at': S },
  },
  import: {
    usage: 'cupel import <file...> [--format cupel|junit] [--out <file>] [--runtime-name <n>] [--runtime-version <v>]',
    about: 'convert JUnit XML (or check a Cupel input) into an input',
    options: { format: S, out: S, 'runtime-name': S, 'runtime-version': S },
    positionals: true,
  },
  validate: {
    usage: 'cupel validate <file>',
    about: 'check an input, report or config against the spec schemas',
    options: {},
    positionals: true,
  },
  conformance: {
    usage: 'cupel conformance --adapter "<command>" [--fixtures <dir>]',
    about: 'run an adapter on every fixture and match expected.json',
    options: { adapter: S, fixtures: S },
  },
  mcp: {
    usage: 'cupel mcp [--root <dir>]',
    about: 'start the local MCP server over stdio',
    options: { root: S },
  },
};

function help() {
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
  return `cupel: know which tests protect you (${SPEC_VERSION})

Usage: cupel <command> [options]

Commands:
${Object.entries(COMMANDS).map(([c, d]) => `  ${c.padEnd(width)}  ${d.about}`).join('\n')}

Common options:
  --config <file>  config file (default: cupel.json at the git root)
  --json           print the engine report as JSON
  --out <file>     where to write the collected input (report: .cupel/input.json)
  --quiet, -q      no progress messages
  --help, -h       show help (also: cupel <command> --help)
  --version        show the version

Exit codes: 0 ok, 1 a guardrail or check failed, 2 usage or invalid input, 3 environment.
See docs/cli.md.
`;
}

function version() {
  return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
}

function parse(command, argv) {
  const spec = COMMANDS[command];
  try {
    return parseArgs({ args: argv, options: { ...COMMON, ...spec.options }, allowPositionals: !!spec.positionals, strict: true });
  } catch (e) {
    throw usage(`${command}: ${e.message}\nusage: ${spec.usage}`);
  }
}

const STUB_INPUT = Object.freeze({
  spec: SPEC_VERSION, kind: 'input', runtime: { name: 'stub', version: '0' }, sources: {}, tests: [], coverage: { granularity: 'test' },
});

class Context {
  constructor(command, parsed, io) {
    this.command = command;
    this.o = parsed.values;
    this.positionals = parsed.positionals;
    this.io = io;
    this.cwd = io.cwd;
    this.env = io.env;
    this.schemas = loadSchemas();
    this.log = this.o.quiet ? () => {} : (msg) => io.err(`cupel: ${msg}\n`);
    this.args = {};
    this.runs(); // validates --runs up front, whatever the command reads
    if (this.o['generated-at'] !== undefined) this.args.generatedAt = this.o['generated-at'];
  }

  get root() {
    this._root ??= projectRoot(this.cwd);
    return this._root;
  }

  /** The raw config, loaded on first use so validate, import and conformance never need one. */
  get config() {
    this._config ??= loadConfig(this.root, this.cwd, this.o.config);
    return this._config;
  }

  path(p) {
    return resolve(this.cwd, p);
  }

  readInput(p) {
    return readJson(this.path(p), 'input');
  }

  runs() {
    const r = this.o.runs;
    if (r === undefined) return 2;
    if (!/^[1-9][0-9]*$/.test(r)) throw usage(`--runs needs a positive integer, got ${JSON.stringify(r)}`);
    return Number(r);
  }

  effective() {
    return effectiveConfig(this.config, this.schemas.config);
  }

  engine(command, inputs, args = this.args) {
    return run(command, inputs, this.config, args, this.schemas);
  }

  /**
   * Before collecting, stops on an invalid config or invalid arguments, with the engine's own report
   * (exit 2). Unknown tests are not judged here: the stub input has none.
   */
  preflight(command, args = this.args) {
    const stubs = command === 'guard' || (command === 'check' && this.needsBase())
      ? { base: STUB_INPUT, head: STUB_INPUT } : { input: STUB_INPUT };
    const r = this.engine(command, stubs, args);
    if (r.exit === EXIT_USAGE && !r.report.diagnostics.some((d) => d.code === 'unknown-test' || d.code === 'unknown-unit')) return r;
    return null;
  }

  needsBase() {
    return this.o.base !== undefined || this.o['base-input'] !== undefined;
  }

  async mutator() {
    if (this.o['no-mutation']) return null;
    const m = await loadModule('mutator', this.env);
    if (!m && this.io.strictDependencies) throw environment('mutation not available');
    if (!m) this.log('mutation not available; continuing without mutation data');
    return m;
  }

  emit(result) {
    this.io.result?.(result);
    if (this.o.json) this.io.out(`${JSON.stringify(result.report, null, 2)}\n`);
    else this.io.out(formatReport(this.command, result.report, this.io.colour));
    return result.exit;
  }

  writeCollected(input, fallback) {
    const target = this.o.out !== undefined ? this.path(this.o.out) : fallback;
    if (!target) return;
    writeJson(target, input);
    this.log(`wrote ${relative(this.cwd, target) || target}`);
  }
}

/** Collects the working tree with mutation per config. */
async function collectHead(ctx, { collector, mutator, cfg, changed }) {
  let input = await collectTree(collector, { root: ctx.root, cfg, runs: ctx.runs(), log: ctx.log });
  if (mutator && ['node', 'python'].includes(input.runtime.name)) {
    const changedScope = cfg.mutation.changedLines ? changed ?? null : null;
    const m = await mutate(mutator, { root: ctx.root, cfg, input, scope: { critical: cfg.mutation.critical, changed: changedScope }, log: ctx.log });
    if (m) input = { ...input, mutation: m };
  }
  return input;
}

/** Collects a git ref in a temporary directory, with critical mutation per config. */
function collectBase(ctx, { collector, mutator, cfg, ref }) {
  return collectRef(collector, { root: ctx.root, ref, cfg, runs: ctx.runs(), log: ctx.log }, async (dir, input) => {
    if (!mutator || !['node', 'python'].includes(input.runtime.name)) return input;
    const m = await mutate(mutator, { root: dir, cfg, input, scope: { critical: cfg.mutation.critical }, log: ctx.log });
    return m ? { ...input, mutation: m } : input;
  });
}

/** Base and head for check and guard, from files, a git ref and the working tree. */
async function baseAndHead(ctx, headOption) {
  const o = ctx.o;
  if (o.base !== undefined && o['base-input'] !== undefined) throw usage('use either --base or --base-input, not both');
  if (o.base !== undefined) checkRef(o.base, '--base');
  const headFile = o[headOption] ?? o['head-input'];
  const needCollector = headFile === undefined || o.base !== undefined;
  const cfg = ctx.effective();
  const collector = needCollector ? await requireCollector(ctx.env, ctx.root, cfg) : null;
  const mutator = needCollector ? await ctx.mutator() : null;
  let base = o['base-input'] !== undefined ? ctx.readInput(o['base-input']) : undefined;
  if (o.base !== undefined) base = await collectBase(ctx, { collector, mutator, cfg, ref: o.base });
  let head;
  if (headFile !== undefined) head = ctx.readInput(headFile);
  else {
    const changed = o.base !== undefined && mutator && cfg.mutation.changedLines ? changedLines(ctx.root, o.base) : null;
    head = await collectHead(ctx, { collector, mutator, cfg, changed });
    if (mutator && base && head.mutation) {
      const ids = lostSurvivors(base, head);
      const mutation = await confirm(mutator, { root: ctx.root, cfg, input: head, mutation: head.mutation, ids, log: ctx.log });
      head = { ...head, mutation };
    }
    ctx.writeCollected(head, null);
  }
  return { base, head };
}

/** One input for report, plan and label: `--input`, or collected from the working tree. */
async function singleInput(ctx, { mutation }) {
  if (ctx.o.input !== undefined) return { input: ctx.readInput(ctx.o.input), collected: false };
  const cfg = ctx.effective();
  const collector = await requireCollector(ctx.env, ctx.root, cfg);
  const mutator = mutation ? await ctx.mutator() : null;
  const input = await collectHead(ctx, { collector, mutator, cfg, changed: null });
  return { input, collected: true, collector, mutator, cfg };
}

/** Replaces the shared-process coverage of re-checked units with their own-process coverage (K4). */
function mergeRecheck(first, second) {
  const ids = (x) => x.tests.map((t) => t.id).sort(cmp).join('\n');
  if (ids(first) !== ids(second)) throw environment('the suite changed between the two collection passes');
  const rechecked = [...(second.coverage.rechecked ?? [])].sort(cmp);
  const set = new Set(rechecked);
  const byTest = { ...(first.coverage.byTest ?? {}) };
  for (const t of second.tests) {
    if (!set.has(t.unit ?? t.id)) continue;
    if (second.coverage.byTest?.[t.id] !== undefined) byTest[t.id] = second.coverage.byTest[t.id];
    else delete byTest[t.id];
  }
  return { ...first, coverage: { ...first.coverage, byTest, rechecked } };
}

const commands = {
  async report(ctx) {
    const pre = ctx.o.input === undefined && ctx.preflight('report');
    if (pre) return ctx.emit(pre);
    const got = await singleInput(ctx, { mutation: true });
    let { input } = got;
    let result = ctx.engine('report', { input });
    const { collector, mutator, cfg } = got;
    if (got.collected && ctx.o.evidence && mutator && ['node', 'python'].includes(input.runtime.name) && result.exit === EXIT_OK) {
      // Optional evidence pass: re-check units whose unique coverage is unverified.
      const candidates = result.report.units
        .filter((u) => u.hints.includes('no-unique-coverage-unverified'))
        .map((u) => u.id)
        .slice(0, cfg.mutation.maxMutants);
      if (candidates.length) {
        ctx.log(`re-checking ${candidates.length} unit(s) without unique coverage`);
        const again = await collectTree(collector, { root: ctx.root, cfg, runs: 1, recheck: candidates, log: ctx.log });
        input = mergeRecheck(input, again);
        if (cfg.mutation.targeted) {
          let m = await mutate(mutator, { root: ctx.root, cfg, input, scope: { critical: false, targeted: candidates }, log: ctx.log });
          if (m) {
            const survivors = m.mutants.filter((x) => x.status === 'survived').map((x) => x.id);
            m = await confirm(mutator, { root: ctx.root, cfg, input, mutation: m, ids: survivors, log: ctx.log });
            input = { ...input, mutation: mergeMutation(input.mutation, m) };
          }
        }
        result = ctx.engine('report', { input });
      }
    }
    if (got.collected) ctx.writeCollected(input, join(ctx.root, '.cupel', 'input.json'));
    return ctx.emit(result);
  },

  async label(ctx) {
    const pre = ctx.o.input === undefined && ctx.preflight('label');
    if (pre) return ctx.emit(pre);
    const { input, collected } = await singleInput(ctx, { mutation: false });
    if (collected) ctx.writeCollected(input, null);
    return ctx.emit(ctx.engine('label', { input }));
  },

  async plan(ctx) {
    const o = ctx.o;
    if (o.changed !== undefined && o['changed-lines'] !== undefined) throw usage('use either --changed or --changed-lines, not both');
    const args = { ...ctx.args };
    if (o.changed !== undefined) {
      checkRef(o.changed, '--changed');
      args.changed = changedLines(ctx.root, o.changed);
    }
    if (o['changed-lines'] !== undefined) args.changed = readJson(ctx.path(o['changed-lines']), 'changed lines');
    const pre = o.input === undefined && ctx.preflight('plan', args);
    if (pre) return ctx.emit(pre);
    const { input, collected } = await singleInput(ctx, { mutation: false });
    if (collected) ctx.writeCollected(input, null);
    return ctx.emit(ctx.engine('plan', { input }, args));
  },

  async check(ctx) {
    if (ctx.o.input !== undefined && ctx.o['head-input'] !== undefined) throw usage('use either --input or --head-input, not both');
    const collecting = (ctx.o.input ?? ctx.o['head-input']) === undefined || ctx.o.base !== undefined;
    const pre = collecting && !ctx.io.allTests && ctx.preflight('check', { ...ctx.args, tests: ctx.positionals });
    if (pre) return ctx.emit(pre);
    const { base, head } = await baseAndHead(ctx, 'input');
    const requested = ctx.io.allTests && ctx.positionals.length === 0
      ? [...new Set((head.tests ?? []).map((t) => t.unit ?? t.id))].sort(cmp)
      : ctx.positionals;
    const tests = expandTests(ctx, requested, head);
    const args = { ...ctx.args, tests };
    return ctx.emit(ctx.engine('check', base !== undefined ? { base, head } : { input: head }, args));
  },

  async guard(ctx) {
    if (ctx.o.base === undefined && ctx.o['base-input'] === undefined) throw usage(`guard needs --base <ref> or --base-input <file>\nusage: ${COMMANDS.guard.usage}`);
    const args = { ...ctx.args };
    if (ctx.io.approvals !== undefined) args.approvals = ctx.io.approvals;
    else if (ctx.o.approvals !== undefined) {
      // A list of { action, id, by }, or an object with that list as `approvals`.
      const a = readJson(ctx.path(ctx.o.approvals), 'approvals');
      args.approvals = a !== null && typeof a === 'object' && !Array.isArray(a) && Object.hasOwn(a, 'approvals') ? a.approvals : a;
    }
    const collecting = ctx.o['head-input'] === undefined || ctx.o.base !== undefined;
    const pre = collecting && ctx.preflight('guard', args);
    if (pre) return ctx.emit(pre);
    const { base, head } = await baseAndHead(ctx, 'head-input');
    return ctx.emit(ctx.engine('guard', { base, head }, args));
  },

  async validate(ctx) {
    if (ctx.positionals.length !== 1) throw usage(`validate needs exactly one file\nusage: ${COMMANDS.validate.usage}`);
    const file = ctx.positionals[0];
    let text;
    try {
      text = readFileSync(ctx.path(file), 'utf8');
    } catch (e) {
      throw usage(`cannot read ${file}: ${e.code ?? e.message}`);
    }
    const result = validateDocument(ctx, text);
    if (ctx.o.json) ctx.io.out(`${JSON.stringify({ file, ...result }, null, 2)}\n`);
    else if (result.valid) ctx.io.out(`${file}: valid ${result.kind}\n`);
    else {
      ctx.io.out(`${file}: invalid ${result.kind ?? 'document'}, ${result.errors.length} error(s)\n`);
      for (const e of result.errors) ctx.io.out(`  ${e.path || '/'}: ${e.code ? `${e.code}: ` : ''}${e.message}\n`);
    }
    return result.valid ? EXIT_OK : EXIT_FAILED;
  },

  async import(ctx) {
    const files = ctx.positionals;
    if (!files.length) throw usage(`import needs a file\nusage: ${COMMANDS.import.usage}`);
    const format = ctx.o.format ?? 'cupel';
    let doc;
    if (format === 'cupel') {
      if (files.length !== 1) throw usage('import --format cupel reads exactly one file');
      doc = readJson(ctx.path(files[0]), 'input');
    } else if (format === 'junit') {
      const docs = files.map((f) => {
        try {
          return { path: f, text: readFileSync(ctx.path(f), 'utf8') };
        } catch (e) {
          throw usage(`cannot read ${f}: ${e.code ?? e.message}`);
        }
      });
      try {
        doc = junitToInput(docs, { name: ctx.o['runtime-name'], version: ctx.o['runtime-version'] });
      } catch (e) {
        throw usage(`${e instanceof XmlError ? 'not well-formed XML: ' : ''}${e.message}`);
      }
    } else {
      throw usage(`import: unknown --format ${JSON.stringify(format)} (cupel or junit)`);
    }
    const errors = inputErrors(ctx, doc);
    if (errors.length) {
      ctx.io.err(`cupel import: the ${format === 'junit' ? 'converted ' : ''}input is invalid\n`);
      for (const e of errors) ctx.io.err(`  ${e.path || '/'}: ${e.code ? `${e.code}: ` : ''}${e.message}\n`);
      return EXIT_USAGE;
    }
    if (ctx.o.out !== undefined) writeJson(ctx.path(ctx.o.out), doc);
    else ctx.io.out(`${JSON.stringify(doc, null, 2)}\n`);
    return EXIT_OK;
  },

  async conformance(ctx) {
    const adapter = ctx.o.adapter;
    if (!adapter) throw usage(`conformance needs --adapter "<command>"\nusage: ${COMMANDS.conformance.usage}`);
    const root = ctx.o.fixtures !== undefined ? ctx.path(ctx.o.fixtures) : FIXTURES_DIR;
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw environment(`conformance fixtures not found at ${root}; pass --fixtures <dir>`);
    }
    const dirs = readdirSync(root).filter((d) => existsSync(join(root, d, 'expected.json'))).sort(cmp);
    if (!dirs.length) throw environment(`no fixtures with expected.json in ${root}`);
    const results = [];
    for (const name of dirs) {
      const dir = join(root, name);
      const expected = readJson(join(dir, 'expected.json'), 'expected');
      const r = spawnSync(adapter, { cwd: dir, shell: true, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
      const mismatches = [];
      if (r.error || r.status !== 0) {
        const tail = (r.stderr ?? '').trim().split('\n').slice(-1)[0];
        mismatches.push(`adapter ${r.error ? `could not run: ${r.error.message}` : `exited ${r.status}`}${tail ? `: ${tail}` : ''}`);
      } else {
        let actual;
        try {
          actual = JSON.parse(r.stdout);
        } catch (e) {
          mismatches.push(`standard output is not JSON: ${e.message}`);
        }
        if (actual !== undefined) {
          for (const e of schemaValidate(ctx.schemas.input, actual)) mismatches.push(`schema ${e.path || '/'}: ${e.message}`);
          mismatches.push(...match(expected, actual));
        }
      }
      results.push({ fixture: name, pass: mismatches.length === 0, mismatches });
    }
    const pass = results.every((r) => r.pass);
    if (ctx.o.json) ctx.io.out(`${JSON.stringify({ adapter, pass, fixtures: results }, null, 2)}\n`);
    else {
      for (const r of results) {
        ctx.io.out(`${r.pass ? 'pass' : 'FAIL'}  ${r.fixture}\n`);
        for (const m of r.mismatches) ctx.io.out(`  ${m}\n`);
      }
      ctx.io.out(`${results.filter((r) => r.pass).length}/${results.length} fixtures pass\n`);
    }
    return pass ? EXIT_OK : EXIT_FAILED;
  },
};

/** A file argument expands to the unit ids of the tests in that file; anything else is an id. */
function expandTests(ctx, names, head) {
  const tests = Array.isArray(head?.tests) ? head.tests : [];
  const unitsByFile = new Map();
  for (const t of tests) {
    if (!t || typeof t.file !== 'string') continue;
    if (!unitsByFile.has(t.file)) unitsByFile.set(t.file, new Set());
    unitsByFile.get(t.file).add(t.unit ?? t.id);
  }
  const ids = new Set(tests.map((t) => t?.id));
  const out = [];
  for (const name of names) {
    let file = null;
    if (!ids.has(name) && unitsByFile.has(name)) file = name;
    else if (!ids.has(name)) {
      const abs = ctx.path(name);
      if (existsSync(abs) && statSync(abs).isFile()) {
        const rel = relative(ctx.root, abs).split(sep).join('/');
        if (unitsByFile.has(rel)) file = rel;
      }
    }
    if (file !== null) out.push(...[...unitsByFile.get(file)].sort(cmp));
    else out.push(name);
  }
  return [...new Set(out)];
}

/** Schema and integrity errors of an input, from the engine (I1-I3). */
function inputErrors(ctx, doc) {
  const r = run('validate', { input: doc }, {}, {}, ctx.schemas);
  return r.report.diagnostics.filter((d) => d.severity === 'error').map(({ code, path, message }) => ({ code, path: path ?? '', message }));
}

function validateDocument(ctx, text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { kind: null, valid: false, errors: [{ path: '', message: `not valid JSON: ${e.message}` }] };
  }
  const isObject = doc !== null && typeof doc === 'object' && !Array.isArray(doc);
  const kind = isObject && doc.kind !== undefined ? doc.kind : 'config';
  let errors;
  if (kind === 'input') errors = inputErrors(ctx, doc);
  else if (kind === 'report') errors = schemaValidate(ctx.schemas.report, doc).map((e) => ({ path: e.path, message: e.message }));
  else if (kind === 'config') {
    // The engine's own config checks (schema, and tier words without tokens).
    const r = run('validate', { input: STUB_INPUT }, doc, {}, ctx.schemas);
    errors = r.report.diagnostics.filter((d) => d.code === 'invalid-config').map(({ code, path, message }) => ({ code, path: path ?? '', message }));
  } else {
    return { kind: null, valid: false, errors: [{ path: '/kind', message: `unknown kind ${JSON.stringify(kind)}: expected "input" or "report", or no kind for a config` }] };
  }
  return { kind, valid: errors.length === 0, errors };
}

/**
 * Runs the CLI. `io`: { cwd, env, out(text), err(text), colour }. Returns the exit code.
 */
export async function main(argv, io) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    io.out(help());
    return cmd ? EXIT_OK : EXIT_USAGE;
  }
  if (cmd === '--version' || cmd === '-v') {
    io.out(`${version()}\n`);
    return EXIT_OK;
  }
  if (!Object.hasOwn(COMMANDS, cmd)) {
    io.err(`cupel: unknown command "${cmd}" (see cupel --help)\n`);
    return EXIT_USAGE;
  }
  try {
    const parsed = parse(cmd, rest);
    if (parsed.values.help) {
      io.out(`usage: ${COMMANDS[cmd].usage}\n\n${COMMANDS[cmd].about}. See docs/${cmd === 'mcp' ? 'mcp' : 'cli'}.md.\n`);
      return EXIT_OK;
    }
    if (cmd === 'mcp') {
      if (parsed.positionals.length) throw usage('mcp takes no positional arguments');
      const { startServer } = await import('../mcp/server.mjs');
      return await startServer({ cwd: io.cwd, env: io.env, rootOption: parsed.values.root, err: io.err });
    }
    const ctx = new Context(cmd, parsed, io);
    return await commands[cmd](ctx);
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`cupel ${cmd}: ${e.message}\n`);
      return e.exit;
    }
    io.err(`cupel ${cmd}: internal error: ${e?.stack ?? e}\n`);
    return EXIT_ENV;
  }
}
