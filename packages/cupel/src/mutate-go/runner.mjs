import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { cmp } from '../engine/order.mjs';
import { GoMutationError } from './errors.mjs';
import { isInvalidGoSource } from './compile-diagnostics.mjs';
import { refuse } from './errors.mjs';
import { parseInventory } from './inventory.mjs';
import { orderGoPackages, shouldStopGo } from './order.mjs';
import { goEnv, run } from './process.mjs';
import { baselineMatches, classifyGo, parseGoResults } from './results.mjs';
import { goReuseBasisValid, goRunRegex, selectGoTests } from './selection.mjs';
import { applyGoSite } from './sites.mjs';
import { prepareGoSwitches, verifyGoSwitch } from './switch-runner.mjs';

const testsArgs = ['test', '-json', '-count=1', '-p=1'];
const VERIFIED_GO_VERSION = '1.27.1';
const median = (values = []) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};
const uniqueSorted = (values) => [...new Set(values)].sort(cmp);

export class GoSession {
  constructor(root, input, facts, deadline, metrics, scope = {}) {
    this.root = resolve(root);
    this.input = input;
    this.facts = facts;
    this.deadline = deadline;
    this.metrics = metrics;
    this.catchers = scope.catchers ?? {};
    this.firstCatch = !!scope.firstCatch;
    this.targeted = new Set(scope.targeted ?? []);
    this.timings = !!scope.timings;
    this.env = goEnv(this.root);
    // A caller's switch must never leak into an unmutated or individual run.
    delete this.env.CUPEL_FAULT;
    const scratchRoot = join(this.root, '.scratch');
    mkdirSync(scratchRoot, { recursive: true });
    this.scratch = mkdtempSync(join(scratchRoot, 'cupel-mutate-go-'));
    this.sequence = 0;
    this.baselines = new Map();
    this.switches = new Map();
    this.stats = { goCalls: 0, compileCalls: 0, testCalls: 0, compileMs: 0, testMs: 0 };
    this.verified = 0;
  }

  close() { rmSync(this.scratch, { recursive: true, force: true }); }
  remaining() { return Math.max(0, this.deadline - performance.now()); }

  recordHelperBuild(result) {
    this.stats.goCalls++;
    this.stats.compileMs += result.wallMs;
  }

  async guarded(command, args, options = {}) {
    this.facts.assertFresh();
    let result;
    try {
      result = await run(command, args, {
        root: options.root ?? this.root, env: options.env ?? this.env,
        input: options.input, timeoutMs: Math.max(1, options.timeoutMs ?? this.remaining()),
      });
    } finally { this.facts.assertFresh(); }
    if (command === 'go') {
      this.stats.goCalls++;
      if (args[0] === 'test' && args[1] === '-c') {
        this.stats.compileCalls++;
        this.stats.compileMs += result.wallMs;
        if (this.metrics) this.metrics.compileCalls = (this.metrics.compileCalls ?? 0) + 1;
      } else if (args[0] === 'test' && args.includes('-json')) {
        this.stats.testCalls++;
        this.stats.testMs += result.wallMs;
        if (this.metrics) this.metrics.testCalls = (this.metrics.testCalls ?? 0) + 1;
      }
    }
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
  }

  async runPackage(group, overlay, timeoutMs, env = this.env) {
    const args = [...testsArgs, ...(overlay ? [`-overlay=${overlay}`] : []), '-run', goRunRegex(group.names), group.pkg];
    const result = await this.guarded('go', args, { timeoutMs, env });
    let parsed = { statuses: new Map(), packageFailures: new Set() };
    try {
      parsed = parseGoResults(result.stdout, this.inventory, { allowTrailingPartial: result.timedOut || !!result.signal });
    } catch (error) {
      if (!(overlay && error instanceof GoMutationError && error.code === 'go-results')) throw error;
    }
    return { result, parsed };
  }

  baselineKey(group) { return `${group.pkg}\0${group.tests.map((test) => test.id).join('\0')}`; }

  async measureBaseline(group, refresh = false) {
    const key = this.baselineKey(group);
    if (!refresh && this.baselines.has(key)) return this.baselines.get(key);
    const { result, parsed } = await this.runPackage(group, null, Math.min(this.remaining(), 600_000));
    baselineMatches(this.input, result, parsed, group.tests);
    const baseline = { ms: result.wallMs };
    this.baselines.set(key, baseline);
    return baseline;
  }

  async compile(overlay, source, backingFile, packages, timeoutMs) {
    for (const [i, pkg] of packages.entries()) {
      const binary = join(this.scratch, `compile-${this.sequence}-${i}.test`);
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

  /** A switched compile failure is only a reason to use the proven individual path. */
  async compileSwitchedPackage(overlay, pkg) {
    const binary = join(this.scratch, `switched-compile-${++this.sequence}.test`);
    return this.guarded('go', ['test', '-c', `-overlay=${overlay}`, '-o', binary, pkg], {
      timeoutMs: Math.max(1, this.remaining()),
    });
  }

  async trialPackage(overlay, group, limitMs, env = this.env) {
    const { result, parsed } = await this.runPackage(group, overlay, limitMs, env);
    return classifyGo(this.input, result, parsed, group.tests);
  }

  async checkPackage(overlay, group, env = this.env) {
    let baseline = await this.measureBaseline(group);
    let limit = Math.min(this.remaining(), Math.max(1000, baseline.ms * 3));
    let outcome = await this.trialPackage(overlay, group, limit, env);
    if (outcome.status === 'survived' || outcome.status === 'killed') return outcome;
    if (this.remaining() < 1) return null;
    baseline = await this.measureBaseline(group, true);
    limit = Math.min(this.remaining(), Math.max(3000, baseline.ms * 9));
    outcome = await this.trialPackage(overlay, group, limit, env);
    if (outcome.status === 'error' || outcome.status === 'timeout') {
      if (this.remaining() < 1) return null;
      await this.measureBaseline(group, true);
    }
    return outcome;
  }

  /**
   * Compile the one overlay once per needed package, then trust only test
   * packages whose switch-off result is byte-for-byte the baseline status set.
   */
  async prepareSwitches(rendered, candidates) {
    return prepareGoSwitches(this, rendered, candidates);
  }

  inputMs(group) {
    return group.tests.reduce((sum, test) => sum + median(test.durationsMs), 0);
  }

  packageOrder(site, selection) {
    const testById = new Map(this.input.tests.map((test) => [test.id, test]));
    const counterpart = site.source.endsWith('.go') ? `${site.source.slice(0, -3)}_test.go` : '';
    const nearPackages = this.input.tests.filter((test) => test.file === counterpart)
      .map((test) => this.inventory.testPkg.get(test.file)).filter(Boolean);
    return orderGoPackages({
      packages: selection.packages,
      previousCatchers: this.catchers[site.id] ?? [],
      packageOfTest: (id) => {
        const test = testById.get(id);
        return test ? this.inventory.testPkg.get(test.file) : undefined;
      },
      nearPackages,
      inputMs: (pkg) => this.inputMs(selection.packages.get(pkg)),
    });
  }

  targetedSelection(selection) {
    return selection.tests.some((test) => this.targeted.has(test.unit ?? test.id));
  }

  /** Reuse must not bypass the complete run owed to a targeted unit. */
  needsFull(site) {
    return this.targetedSelection(selectGoTests(this.input, this.inventory, site));
  }

  /** The shared K15 basis must include every test file Go compiles. */
  canReuse(site) { return goReuseBasisValid(this.input, this.inventory, site); }

  async evaluate(site, overlay, selection, env = this.env) {
    const outcomes = [];
    let catching = 0;
    const targeted = this.targetedSelection(selection);
    for (const pkg of this.packageOrder(site, selection)) {
      if (shouldStopGo({ catching, firstCatch: this.firstCatch, targeted })) break;
      if (this.remaining() < 1) return null;
      const outcome = await this.checkPackage(overlay, selection.packages.get(pkg), env);
      if (!outcome) return null;
      outcomes.push(outcome);
      if (outcome.status === 'killed') catching++;
    }
    const killedBy = uniqueSorted(outcomes.filter((outcome) => outcome.status === 'killed').flatMap((outcome) => outcome.killedBy));
    if (killedBy.length) return { status: 'killed', killedBy };
    if (outcomes.some((outcome) => outcome.status === 'timeout')) return { status: 'timeout', killedBy: [] };
    if (outcomes.some((outcome) => outcome.status === 'error')) return { status: 'error', killedBy: [] };
    return { status: 'survived', killedBy: [] };
  }

  async withIndividual(site, bytes, task) {
    const selection = selectGoTests(this.input, this.inventory, site);
    if (!selection.packages.size) return { status: 'no-coverage', killedBy: [] };
    if (this.remaining() < 1) return null;
    const serial = ++this.sequence;
    const mutant = join(this.scratch, `source-${serial}.go`);
    const overlay = join(this.scratch, `overlay-${serial}.json`);
    writeFileSync(mutant, applyGoSite(bytes, site));
    writeFileSync(overlay, JSON.stringify({ Replace: { [join(this.root, site.source)]: mutant } }));
    try {
      const owner = this.inventory.sourcePkg.get(site.source);
      if (!owner) refuse('inventory', `no Go package owns ${site.source}`);
      // The target source's package first: only its diagnostic proves a mutant compile-invalid.
      const packages = [owner, ...uniqueSorted(this.packageOrder(site, selection)).filter((pkg) => pkg !== owner)];
      const compile = await this.compile(overlay, site.source, mutant, packages, this.remaining());
      if (compile.kind === 'invalid') return { invalid: true };
      if (compile.kind === 'cut' || this.remaining() < 1) return null;
      // Await before finally removes the overlay: `go test` reads it after the
      // child starts, so returning the promise directly races cleanup.
      return await task({ overlay, selection });
    } finally {
      rmSync(mutant, { force: true });
      rmSync(overlay, { force: true });
    }
  }

  async check(site, bytes, { individual = false } = {}) {
    const started = performance.now();
    const switched = !individual ? this.switches.get(site.id) : null;
    let outcome;
    if (switched) {
      const selection = selectGoTests(this.input, this.inventory, site);
      outcome = await this.evaluate(site, this.switchedOverlay, selection, { ...this.env, CUPEL_FAULT: String(switched.number) });
      if (outcome) outcome._switched = true;
    } else {
      outcome = await this.withIndividual(site, bytes, ({ overlay, selection }) => this.evaluate(site, overlay, selection));
    }
    if (outcome && !outcome.invalid && this.timings && outcome.status !== 'no-coverage')
      outcome.durationMs = Math.round(performance.now() - started);
    return outcome;
  }

  async verifySwitched(site, bytes, expected) { return verifyGoSwitch(this, site, bytes, expected); }
}
