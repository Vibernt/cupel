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
    if (!ctx.o.input || !ctx.o.out) throw usage('mutate needs --input FILE and --out FILE');
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
    const mutation = await mutate(mutator, { root: ctx.root, cfg, input,
      scope: { critical: cfg.mutation.critical, changed }, log: ctx.log });
    if (!mutation) throw environment('mutation is unavailable for the configured scope');
    let confirmed = mutation;
    if (base) {
      // K7, as guard does when it collects the head itself: survivors detected at base are re-run.
      const ids = lostSurvivors(base, { mutation });
      confirmed = await confirm(mutator, { root: ctx.root, cfg, input, mutation, ids, log: ctx.log });
    }
    const result = { ...input, mutation: confirmed };
    const resultErrors = inputErrors(ctx, result);
    if (resultErrors.length) throw environment(`mutated input is invalid: ${resultErrors[0].path}: ${resultErrors[0].message}`);
    const output = ctx.path(ctx.o.out);
    mkdirSync(dirname(output), { recursive: true });
    writeAtomicJson(output, result);
    if (!ctx.o.quiet) ctx.io.err(`cupel: mutation input written to ${output}\n`);
    return EXIT_OK;
  },
};
