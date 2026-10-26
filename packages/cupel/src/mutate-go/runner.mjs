import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { lines as parseLines } from '../engine/lines.mjs';
import { GoMutationError } from './errors.mjs';
import { isInvalidGoSource } from './compile-diagnostics.mjs';
import { refuse } from './errors.mjs';
import { parseInventory } from './inventory.mjs';
import { goEnv, run } from './process.mjs';
import { baselineMatches, classifyGo, parseGoResults } from './results.mjs';
import { applyGoSite } from './sites.mjs';

const testsArgs = ['test', '-json', '-count=1', '-p=1'];
const VERIFIED_GO_VERSION = '1.27.1';
const covers = (value, line) => parseLines(value ?? '').some(([a, b]) => a <= line && line <= b);

export function coveredByInput(input, site) {
  for (const row of Object.values(input.coverage.byTest ?? {}))
    if (covers(row[site.source], site.line)) return true;
  for (const row of Object.values(input.coverage.setup ?? {}))
    if (covers(row[site.source], site.line)) return true;
  for (const row of Object.values(input.coverage.byFile ?? {}))
    if (covers(row[site.source], site.line)) return true;
  return false;
}

export class GoSession {
  constructor(root, input, facts, deadline, metrics) {
    this.root = resolve(root);
    this.input = input;
    this.facts = facts;
    this.deadline = deadline;
    this.metrics = metrics;
    this.env = goEnv(this.root);
    const scratchRoot = join(this.root, '.scratch');
    mkdirSync(scratchRoot, { recursive: true });
    this.scratch = mkdtempSync(join(scratchRoot, 'cupel-mutate-go-'));
    this.sequence = 0;
  }

  close() { rmSync(this.scratch, { recursive: true, force: true }); }
  remaining() { return Math.max(0, this.deadline - performance.now()); }

  async guarded(command, args, options = {}) {
    this.facts.assertFresh();
    let result;
    try {
      result = await run(command, args, {
        root: options.root ?? this.root, env: options.env ?? this.env,
        input: options.input, timeoutMs: Math.max(1, options.timeoutMs ?? this.remaining()),
      });
    } finally { this.facts.assertFresh(); }
    if (this.metrics) this.metrics.commands = (this.metrics.commands ?? 0) + 1;
    return result;
  }

  async prepare() {
    const version = await this.guarded('go', ['version'], { timeoutMs: Math.min(this.remaining(), 30_000) });
    const actual = version.stdout.trim().match(/\bgo([0-9][^ ]*)\b/)?.[1];
    if (version.status !== 0 || !actual || this.input.runtime?.name !== 'go' || actual !== this.input.runtime.version)
      refuse('go-runtime', `Go runtime differs from collected input (${this.input.runtime?.version ?? 'missing'} vs ${actual ?? 'unknown'})`);
    if (actual !== VERIFIED_GO_VERSION)
      refuse('unsupported-go-runtime', `Go mutation is verified on Go ${VERIFIED_GO_VERSION}; found ${actual}`);
    const listing = await this.guarded('go', ['list', '-json', './...'], { timeoutMs: Math.min(this.remaining(), 120_000) });
    if (listing.status !== 0 || listing.signal || listing.timedOut)
      refuse('inventory', `go list failed offline: ${listing.stderr.trim()}`);
    this.inventory = parseInventory(this.root, listing.stdout, this.input, this.metrics);
    await this.probeBaseline();
  }

  async runModule(overlay, timeoutMs) {
    const args = [...testsArgs, ...(overlay ? [`-overlay=${overlay}`] : []), './...'];
    const result = await this.guarded('go', args, { timeoutMs });
    let parsed = { statuses: new Map(), packageFailures: new Set() };
    if (!result.timedOut && !result.signal) {
      try { parsed = parseGoResults(result.stdout, this.inventory); }
      catch (error) {
        if (!(overlay && error instanceof GoMutationError && error.code === 'go-results')) throw error;
      }
    }
    return { result, parsed };
  }

  async probeBaseline() {
    const { result, parsed } = await this.runModule(null, Math.min(this.remaining(), 600_000));
    baselineMatches(this.input, result, parsed);
    this.baselineMs = result.wallMs;
  }

  async compile(overlay, source, backingFile, timeoutMs) {
    for (const [i, pkg] of this.inventory.testPackages.entries()) {
      const binary = join(this.scratch, `compile-${i}.test`);
      const result = await this.guarded('go', ['test', '-c', `-overlay=${overlay}`, '-o', binary, pkg], { timeoutMs });
      if (result.timedOut) return { kind: 'cut' };
      if (result.status !== 0 || result.signal) {
        // A failing unmutated compile means the environment changed, not an invalid mutant.
        const probe = await this.guarded('go', ['test', '-c', '-o', binary, pkg], { timeoutMs });
        if (probe.status !== 0 || probe.signal || probe.timedOut)
          refuse('environment', `known-good Go compile failed for ${pkg}: ${probe.stderr.trim()}`);
        if (pkg !== this.inventory.sourcePkg.get(source) || !isInvalidGoSource(result, source, backingFile))
          refuse('environment', `mutated Go compile failed without a target-source compiler diagnostic for ${source}: ${result.stderr.trim()}`);
        return { kind: 'invalid' };
      }
    }
    return { kind: 'valid' };
  }

  async trial(overlay, limitMs) {
    const { result, parsed } = await this.runModule(overlay, limitMs);
    return classifyGo(this.input, result, parsed);
  }

  async check(site, bytes) {
    if (!coveredByInput(this.input, site)) return { status: 'no-coverage', killedBy: [] };
    if (this.remaining() < 1) return null;
    const serial = ++this.sequence;
    const mutant = join(this.scratch, `source-${serial}.go`);
    const overlay = join(this.scratch, `overlay-${serial}.json`);
    writeFileSync(mutant, applyGoSite(bytes, site));
    writeFileSync(overlay, JSON.stringify({ Replace: { [join(this.root, site.source)]: mutant } }));
    try {
      const compile = await this.compile(overlay, site.source, mutant, this.remaining());
      if (compile.kind === 'invalid') return { invalid: true };
      if (compile.kind === 'cut' || this.remaining() < 1) return null;
      const limit = Math.min(this.remaining(), Math.max(1000, this.baselineMs * 3));
      let outcome = await this.trial(overlay, limit);
      if (outcome.status === 'survived' || outcome.status === 'killed') return outcome;
      if (this.remaining() < 1) return null;
      await this.probeBaseline();
      const retryLimit = Math.min(this.remaining(), Math.max(3000, this.baselineMs * 9));
      outcome = await this.trial(overlay, retryLimit);
      if (outcome.status === 'error' || outcome.status === 'timeout') {
        if (this.remaining() < 1) return null;
        await this.probeBaseline();
      }
      return outcome;
    } finally {
      rmSync(mutant, { force: true });
      rmSync(overlay, { force: true });
    }
  }
}
