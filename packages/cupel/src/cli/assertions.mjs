import { analyseAssertions } from '../analysis/assertions.mjs';
import { readJson, writeJson } from './context.mjs';
import { requireCollector } from './collect.mjs';
import { environment, usage } from './errors.mjs';

export async function assertionsCommand(ctx) {
  let input, sidecar;
  if (ctx.o.input) {
    input = ctx.readInput(ctx.o.input);
    sidecar = readJson(`${ctx.path(ctx.o.input)}.assertions.json`, 'assertion sidecar');
  } else {
    const cfg = ctx.effective();
    const collector = await requireCollector(ctx.env, ctx.root, cfg);
    // External collectors do not implement the recording contract yet. Never silently run without it.
    if (collector.kind !== 'vitest' && !collector.CollectorError) throw usage('assertions supports native node:test and Vitest collectors only');
    const out = ctx.path(ctx.o.out ?? '.scratch/cupel-assertions/input.json');
    try {
      input = await collector.collectNode({ root: ctx.root, config: cfg, runs: 1, log: ctx.log, assertionsOut: `${out}.assertions.json` });
    } catch (error) { throw environment(`assertion collection failed: ${error.message}`); }
    writeJson(out, input);
    sidecar = readJson(`${out}.assertions.json`, 'assertion sidecar');
    ctx.log(`wrote ${out} and ${out}.assertions.json`);
  }
  let report;
  try { report = analyseAssertions(input, sidecar); }
  catch (error) { throw usage(error.message); }
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
