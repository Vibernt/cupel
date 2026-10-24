import { analyseAssertions } from '../analysis/assertions.mjs';
import { readJson, writeJson } from './context.mjs';
import { requireCollector } from './collect.mjs';
import { environment, usage } from './errors.mjs';
import { mergeRunners, splitRunnerInput } from './merge-runners.mjs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const supported = (collector) => collector.kind === 'vitest' || !!collector.CollectorError;

export async function assertionsCommand(ctx) {
  let input, sidecar;
  let reports;
  if (ctx.o.input) {
    input = ctx.readInput(ctx.o.input);
    sidecar = readJson(`${ctx.path(ctx.o.input)}.assertions.json`, 'assertion sidecar');
    if (input.runtimes) {
      if (sidecar?.version !== 'cupel-assertions-multi/1') throw usage('merged input needs a multi-runner assertion sidecar');
      reports = splitRunnerInput(input).filter(({ name }) => sidecar.runners?.[name]).map(({ name, input: part }) => analyseAssertions(part, sidecar.runners[name]));
    }
  } else {
    const cfg = ctx.effective();
    const collector = await requireCollector(ctx.env, ctx.root, cfg);
    // External collectors do not implement the recording contract yet. Never silently run without it.
    if (collector.kind !== 'merged' && !supported(collector)) throw usage('assertions supports native node:test and Vitest collectors only');
    const out = ctx.path(ctx.o.out ?? '.scratch/cupel-assertions/input.json');
    mkdirSync(dirname(out), { recursive: true });
    if (collector.kind === 'merged') {
      const parts = [], sidecars = {};
      for (const runner of collector.runners) {
        try {
          const recording = supported(runner.collector);
          const file = `${out}.${encodeURIComponent(runner.name)}.assertions.json`;
          const part = await runner.collector.collectNode({ root: ctx.root, config: runner.config, runs: 1, log: ctx.log, ...(recording ? { assertionsOut: file } : {}) });
          parts.push({ name: runner.name, input: part });
          if (recording) sidecars[runner.name] = readJson(file, 'assertion sidecar');
        } catch (error) { throw environment(`runner ${runner.name} assertion collection failed: ${error.message}`); }
      }
      input = mergeRunners(parts);
      sidecar = { version: 'cupel-assertions-multi/1', runners: sidecars };
      reports = parts.filter(({ name }) => sidecars[name]).map(({ name, input: part }) => analyseAssertions(part, sidecars[name]));
    } else {
      try {
        input = await collector.collectNode({ root: ctx.root, config: cfg, runs: 1, log: ctx.log, assertionsOut: `${out}.assertions.json` });
      } catch (error) { throw environment(`assertion collection failed: ${error.message}`); }
      sidecar = readJson(`${out}.assertions.json`, 'assertion sidecar');
    }
    writeJson(out, input);
    if (collector.kind === 'merged') writeJson(`${out}.assertions.json`, sidecar);
    ctx.log(`wrote ${out} and ${out}.assertions.json`);
  }
  let report;
  try {
    if (input.runtimes) {
      const used = new Set(Object.keys(sidecar.runners ?? {}));
      report = { kind: 'assertions', version: 'cupel-assertions/1', units: reports.flatMap((r) => r.units), skippedRunners: input.runtimes.map((r) => r.runner).filter((name) => !used.has(name)) };
    } else report = analyseAssertions(input, sidecar);
  }
  catch (error) { throw usage(error.message); }
  if (report.skippedRunners?.length) ctx.log(`assertions skipped unsupported runners: ${report.skippedRunners.join(', ')}`);
  if (ctx.o.json) ctx.io.out(`${JSON.stringify(report, null, 2)}\n`);
  else {
    ctx.io.out('Assertion observations (S10b): review hints, not removal advice.\n');
    for (const u of report.units) {
      if (!u.subsumedBy.length && !u.cloneOf.length && !u.assertionFree && !u.incomplete) continue;
      ctx.io.out(`\n${u.id}: ${u.assertionCount} assertions; ${u.uniqueFingerprints.length} unique fingerprints\n`);
      if (u.incomplete) ctx.io.out(`  incomplete${u.capHit ? ' (recording cap hit)' : ''}; no verdict\n`);
      if (u.assertionFree) ctx.io.out('  assertion-free (zero or only trivial recorded checks)\n');
      if (u.subsumedBy.length) ctx.io.out(`  subsumed by: ${u.subsumedBy.join(', ')}\n`);
      if (u.cloneOf.length) ctx.io.out(`  clone of (K12 >= 0.9): ${u.cloneOf.join(', ')}\n`);
      for (const a of u.records) ctx.io.out(`  ${a.site ? `${a.site.file}:${a.site.line}:${a.site.column}` : 'unknown site'} ${a.matcher}(${a.subject ?? '?'}) expected=${a.expectedFingerprint}${a.trivial ? ' [trivial]' : ''}\n`);
      for (const error of u.errors) ctx.io.out(`  ${error}\n`);
    }
  }
  return 0;
}
