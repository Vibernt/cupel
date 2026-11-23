// The collect-once CLI commands: node:test collection, shard merge and mutation of saved evidence.
import { readFileSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, sep, join, dirname } from 'node:path';
import { run } from '../engine/index.mjs';
import { validate as schemaValidate } from '../engine/schema.mjs';
import { cmp } from '../engine/order.mjs';
import { usage, environment, EXIT_OK, EXIT_FAILED } from './errors.mjs';
import { changedLines } from './git.mjs';
import { mutate, confirm, lostSurvivors } from './collect.mjs';
import { stampCollection } from './collection.mjs';
import { mergeInputs } from './merge-inputs.mjs';
import { writeAtomicJson } from '../collect/atomic-json.mjs';
import { availableParallelism, cpus } from 'node:os';
import { DEFAULT_RULE, assignSlices, mergeMutations, parseShard, planDigest, planReport } from './shard.mjs';

const defaultCores = () => (typeof availableParallelism === 'function' ? availableParallelism() : cpus().length);

/** The plan as text: per runner, faults, estimate and suggested slices. */
function formatPlan(report) {
  const lines = ['Fault-test plan', ''];
  for (const r of report.runners) {
    if (!r.sliceable) { lines.push(`${r.runner}: runs whole (${r.reason})`); continue; }
    lines.push(`${r.runner}: ${r.faults.run} to run, ${r.faults.reused} reused, ${r.faults.noCoverage} on lines no test runs; about ${Math.round(r.estimateSeconds / 60)} min of fault time on one process; ${r.parallel} at once`);
    lines.push(`  suggested: ${r.suggestedShards} slice${r.suggestedShards === 1 ? '' : 's'} (about ${r.expectedMinutes} min each)${r.suggestedShards > 1 ? `: cupel mutate --input <input> --runner ${r.runner} --shard I/${r.suggestedShards} --out <slice>` : ''}`);
  }
  lines.push('', `Rule: one machine while the time fits ${report.rule.targetMinutes} min; otherwise enough slices to fit it, with ${report.rule.startupSeconds} s startup each, at most ${report.rule.maxShards}. Estimates use each fault's measured time from --reuse when present.`);
  return `${lines.join('\n')}\n`;
}

function inputErrors(ctx, doc) {
  return run('validate', { input: doc }, {}, {}, ctx.schemas).report.diagnostics.filter((d) => d.severity === 'error');
}

export const collectionCommands = {
  async 'collect-node'(ctx) {
    const o = ctx.o;
    if (o.tests && o.shard) throw usage('--tests and --shard are mutually exclusive');
    let shard;
    if (o.shard) {
      const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(o.shard);
      if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2])) || Number(match[1]) > Number(match[2])) throw usage(`--shard needs I/N with 1 <= I <= N, got ${JSON.stringify(o.shard)}`);
      shard = { index: Number(match[1]), total: Number(match[2]) };
    }
    const configErrors = schemaValidate(ctx.schemas.config, ctx.config);
    if (configErrors.length) throw usage(`invalid config: ${configErrors[0].path}: ${configErrors[0].message}`);
    const cfg = ctx.effective();
    const { collectNode, resolveTestFiles, CollectorError } = await import('../collect/node/index.mjs');
    let files;
    if (o.tests) {
      const suite = new Set(resolveTestFiles(ctx.root, null, cfg.runners?.node?.tests ?? 'tests/**/*.test.mjs'));
      files = [...new Set(o.tests.map((file) => {
        let relativeFile;
        try { relativeFile = relative(ctx.root, realpathSync(resolve(ctx.root, file))).split(sep).join('/'); }
        catch { throw usage(`--tests file does not exist: ${file}`); }
        if (!suite.has(relativeFile)) throw usage(`--tests file is not in configured suite: ${file}`);
        return relativeFile;
      }))].sort(cmp);
    }
    const output = ctx.path(o.out ?? join(ctx.root, '.cupel/input.json'));
    const sidecar = join(dirname(output), 'skipped.json');
    rmSync(output, { force: true });
    rmSync(sidecar, { force: true });
    const junit = o.junit ? ctx.path(o.junit) : undefined;
    if (junit) mkdirSync(dirname(junit), { recursive: true });
    let input;
    try {
      input = await collectNode({ root: ctx.root, config: cfg, files, runs: o.runs === undefined ? 1 : ctx.runs(),
        shard, subset: !!o.tests, nodeArgs: ctx.nodeArgs ?? [], inherit: !o.quiet, junit, diagnostics: ctx.skipped, strict: true });
    } catch (error) {
      if (error instanceof CollectorError) throw environment(error.message);
      throw error;
    }
    input = stampCollection(input, ctx.root, cfg);
    const errors = inputErrors(ctx, input);
    if (errors.length) throw environment(`collected input is invalid: ${errors[0].path}: ${errors[0].message}`);
    ctx.writeCollected(input, output, { silent: true });
    const counts = { passed: 0, failed: 0, skipped: 0 };
    for (const test of input.tests) counts[test.status]++;
    if (!o.quiet) ctx.io.err(`cupel: tests ${counts.failed ? 'failed' : 'passed'} (${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped); input written to ${output}\n`);
    return counts.failed ? EXIT_FAILED : EXIT_OK;
  },
  'merge-inputs'(ctx) {
    if (!ctx.o.out || !ctx.positionals.length) throw usage('merge-inputs needs shard files and --out FILE');
    const parts = ctx.positionals.map((file) => {
      const input = ctx.readInput(file);
      const errors = inputErrors(ctx, input);
      if (errors.length) throw usage(`${file}: ${errors[0].path}: ${errors[0].message}`);
      return { file, input };
    });
    const merged = mergeInputs(parts);
    const errors = inputErrors(ctx, merged);
    if (errors.length) throw environment(`merged input is invalid: ${errors[0].path}: ${errors[0].message}`);
    const output = ctx.path(ctx.o.out);
    mkdirSync(dirname(output), { recursive: true });
    writeAtomicJson(output, merged);
    if (ctx.o.json) ctx.io.out(`${JSON.stringify(merged, null, 2)}\n`);
    else if (!ctx.o.quiet) ctx.io.err(`cupel: merged ${parts.length} shards; input written to ${output}\n`);
    return EXIT_OK;
  },
  async mutate(ctx) {
    if (!ctx.o.input || (!ctx.o.out && !ctx.o.plan)) throw usage('mutate needs --input FILE and --out FILE (--out is optional with --plan)');
    const input = ctx.readInput(ctx.o.input);
    const errors = inputErrors(ctx, input);
    if (errors.length) throw usage(`${ctx.o.input}: ${errors[0].path}: ${errors[0].message}`);
    if (input.mutation) throw usage('input already has mutation');
    if (input.collection?.shard) throw usage('merge shards before mutation');
    for (const [source, facts] of Object.entries(input.sources)) {
      const sourcePath = resolve(ctx.root, source);
      if (relative(ctx.root, sourcePath).split(sep)[0] === '..' || sourcePath === ctx.root) throw usage(`source path is outside working tree: ${source}`);
      let actual, realSource;
      try { realSource = realpathSync(sourcePath); }
      catch { throw environment(`source is missing from working tree: ${source}`); }
      if (relative(ctx.root, realSource).split(sep)[0] === '..') throw usage(`source path is outside working tree: ${source}`);
      actual = `sha256:${createHash('sha256').update(readFileSync(realSource)).digest('hex')}`;
      if (!facts.hash || actual !== facts.hash) throw environment(`source hash does not match working tree: ${source}`);
    }
    let base;
    if (ctx.o['base-input'] !== undefined) {
      base = ctx.readInput(ctx.o['base-input']);
      const baseErrors = inputErrors(ctx, base);
      if (baseErrors.length) throw usage(`${ctx.o['base-input']}: ${baseErrors[0].path}: ${baseErrors[0].message}`);
    }
    const cfg = ctx.effective();
    const mutator = await ctx.mutator();
    const changed = ctx.o.changed && cfg.mutation.changedLines ? changedLines(ctx.root, ctx.o.changed) : null;
    // --first-catch: only whether each fault was caught, for guard --head-input (mutation.catches 'first').
    const scope = { critical: cfg.mutation.critical, changed, ...(ctx.o.runner ? { runner: ctx.o.runner } : {}), ...(ctx.o['first-catch'] ? { firstCatch: true } : {}) };
    const common = { previous: ctx.previous(), ownFiles: ctx.ownFiles(), root: ctx.root, cfg, input, log: ctx.log };
    const number = (name, fallback, min = 1, integer = false) => {
      if (ctx.o[name] === undefined) return fallback;
      const n = Number(ctx.o[name]);
      if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) throw usage(`--${name} needs ${integer ? 'a whole number' : 'a number'} of at least ${min}, got ${JSON.stringify(ctx.o[name])}`);
      return n;
    };
    const shard = ctx.o.shard === undefined ? null : parseShard(ctx.o.shard);
    if (ctx.o.shard !== undefined && !shard) throw usage(`--shard needs I/N with 1 <= I <= N, got ${JSON.stringify(ctx.o.shard)}`);
    if (ctx.o.plan && shard) throw usage('use either --plan or --shard');
    if (ctx.o.plan || shard) {
      const planned = await mutate(mutator, { ...common, scope: { ...scope, plan: true } });
      const plans = planned?.plans ?? {};
      if (ctx.o.plan) {
        const cores = number('cores', defaultCores(), 1, true);
        const rule = { startupSeconds: number('startup-seconds', DEFAULT_RULE.startupSeconds, 0), targetMinutes: number('target-minutes', DEFAULT_RULE.targetMinutes),
          maxShards: number('max-shards', DEFAULT_RULE.maxShards, 1, true) };
        // JavaScript and Python mutators run about half the cores at once; Rust runs one fault at a time.
        const parallel = Object.fromEntries(Object.keys(plans).map((name) => [name, name === 'cargo' ? 1 : Math.max(1, Math.floor(cores / 2))]));
        const report = planReport(plans, { rule, parallel });
        if (ctx.o.out) { const output = ctx.path(ctx.o.out); mkdirSync(dirname(output), { recursive: true }); writeAtomicJson(output, report); }
        if (ctx.o.json) ctx.io.out(`${JSON.stringify(report, null, 2)}\n`);
        else ctx.io.out(formatPlan(report));
        return EXIT_OK;
      }
      const names = Object.keys(plans).filter((name) => !ctx.o.runner || name === ctx.o.runner);
      const unsliceable = names.filter((name) => !plans[name]?.plan);
      if (unsliceable.length) throw environment(`runner ${unsliceable.join(', ')}: slices are not available; run it whole with --runner`);
      const entries = names.flatMap((name) => plans[name].plan);
      const slices = assignSlices(entries, shard.total);
      const only = entries.filter((e) => slices.get(e.id) === shard.index).map((e) => e.id);
      scope.only = only;
      ctx.sliceInfo = { runner: ctx.o.runner ?? '*', index: shard.index, total: shard.total, plan: planDigest(ctx.o.runner ?? '*', entries, shard.total), assigned: only.length };
      ctx.sliceRunnerOf = new Map(names.flatMap((name) => plans[name].plan.map((e) => [e.id, name])));
      ctx.log(`slice ${shard.index}/${shard.total}: ${only.length} of ${entries.length} planned faults`);
    }
    let mutation = await mutate(mutator, { ...common, scope });
    if (!mutation) throw environment('mutation is unavailable for the configured scope');
    if (ctx.sliceInfo) {
      // A slice that stopped early (maxSeconds, JavaScript and Python) did not answer every fault it was given.
      // Rust faults have no time budget: a missing one did not compile, as in a whole run.
      const answered = new Set(mutation.mutants.map((m) => m.id));
      const cut = scope.only.some((id) => !answered.has(id) && ctx.sliceRunnerOf.get(id) !== 'cargo');
      mutation = { ...mutation, shard: ctx.sliceInfo, ...(cut ? { sampled: true } : {}) };
    } else if (ctx.o.runner) {
      mutation = { ...mutation, shard: { runner: ctx.o.runner, index: 1, total: 1, plan: planDigest(ctx.o.runner, mutation.mutants.map((m) => ({ id: m.id, kind: 'run', estimateMs: 0 })), 1), assigned: mutation.mutants.length } };
    }
    let confirmed = mutation;
    if (base) {
      // K7, as guard does when it collects the head itself: survivors detected at base are re-run.
      const ids = lostSurvivors(base, { mutation });
      confirmed = await confirm(mutator, { ownFiles: ctx.ownFiles(), root: ctx.root, cfg, input, mutation, ids, log: ctx.log });
    }
    const result = { ...input, mutation: { ...confirmed, ...(mutation.shard ? { shard: mutation.shard } : {}) } };
    const resultErrors = inputErrors(ctx, result);
    if (resultErrors.length) throw environment(`mutated input is invalid: ${resultErrors[0].path}: ${resultErrors[0].message}`);
    const output = ctx.path(ctx.o.out);
    mkdirSync(dirname(output), { recursive: true });
    writeAtomicJson(output, result);
    if (!ctx.o.quiet) ctx.io.err(`cupel: mutation input written to ${output}\n`);
    return EXIT_OK;
  },
  async 'merge-mutations'(ctx) {
    if (!ctx.o.input || !ctx.o.out || !ctx.positionals.length) throw usage('merge-mutations needs --input FILE, --out FILE and slice files');
    const base = ctx.readInput(ctx.o.input);
    const parts = ctx.positionals.map((name) => ({ name, doc: ctx.readInput(name) }));
    let mutation;
    try { mutation = mergeMutations(base, parts); } catch (e) { throw usage(`merge-mutations: ${e.message}`); }
    const result = { ...base, mutation };
    const errors = inputErrors(ctx, result);
    if (errors.length) throw environment(`merged input is invalid: ${errors[0].path}: ${errors[0].message}`);
    const output = ctx.path(ctx.o.out);
    mkdirSync(dirname(output), { recursive: true });
    writeAtomicJson(output, result);
    if (!ctx.o.quiet) ctx.io.err(`cupel: merged ${parts.length} parts (${mutation.mutants.length} faults); input written to ${output}\n`);
    return EXIT_OK;
  },
};
