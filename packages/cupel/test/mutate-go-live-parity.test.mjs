import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import nodeTest from 'node:test';
// Go fault testing needs POSIX process-group termination; on Windows it refuses, so these tests skip there (docs/go.md).
const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;
import { collectGo } from '../src/collect/go/index.mjs';
import { GoSourceFacts } from '../src/mutate-go/facts.mjs';
import { mutateGo } from '../src/mutate-go/index.mjs';
import { baselineMatches, classifyGo, parseGoResults } from '../src/mutate-go/results.mjs';
import { GoSession } from '../src/mutate-go/runner.mjs';
import { applyGoSite, buildHelper, sourceSites } from '../src/mutate-go/sites.mjs';

const fixture = resolve(import.meta.dirname, 'fixtures/mutate-go');
const scratch = resolve('.scratch', 'mutate-go-live-parity');

function hasVerifiedGo(t) {
  const result = spawnSync('go', ['version'], { encoding: 'utf8' });
  if (!result.error && result.status === 0 && /\bgo1\.27\.1\b/.test(result.stdout)) return true;
  const message = 'go mutation needs Go 1.27.1';
  if (process.env.CUPEL_REQUIRE_NATIVE_MUTATION === '1') assert.fail(message);
  t.skip(message);
  return false;
}

function project(t) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'case-'));
  for (const file of ['go.mod', 'value.go', 'value_test.go']) copyFileSync(join(fixture, file), join(root, file));
  mkdirSync(join(root, 'other'));
  writeFileSync(join(root, 'other', 'other.go'), 'package other\n\nfunc Value() int { return 1 }\n');
  writeFileSync(join(root, 'other', 'other_test.go'), `package other\n\nimport "testing"\n\nfunc TestValue(t *testing.T) { if Value() != 1 { t.Fatal("bad") } }\n`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** The previous whole-module algorithm, kept only as a live parity oracle. */
async function fullModuleReference(root, input) {
  const metrics = {};
  const facts = new GoSourceFacts(root, input, metrics);
  const session = new GoSession(root, input, facts, performance.now() + 120_000, metrics);
  try {
    await session.prepare();
    const helper = await buildHelper(session.scratch, session.env, session.remaining());
    const bytes = facts.bytes('value.go');
    const sites = await sourceSites(helper, 'value.go', bytes, new Set([3, 5]), root, session.env, session.remaining());
    const runModule = async (overlay = null) => {
      const args = ['test', '-json', '-count=1', '-p=1', ...(overlay ? [`-overlay=${overlay}`] : []), './...'];
      const result = await session.guarded('go', args, { timeoutMs: session.remaining() });
      return { result, parsed: parseGoResults(result.stdout, session.inventory) };
    };
    const baseline = await runModule();
    baselineMatches(input, baseline.result, baseline.parsed);
    const rows = [];
    for (const site of sites) {
      const mutant = join(session.scratch, `reference-${site.line}.go`);
      const overlay = join(session.scratch, `reference-${site.line}.json`);
      writeFileSync(mutant, applyGoSite(bytes, site));
      writeFileSync(overlay, JSON.stringify({ Replace: { [join(root, site.source)]: mutant } }));
      let outcome;
      for (let repetition = 0; repetition < 3; repetition++) {
        session.sequence++;
        const compiled = await session.compile(overlay, site.source, mutant, session.inventory.testPackages, session.remaining());
        assert.equal(compiled.kind, 'valid');
        const trial = await runModule(overlay);
        outcome = classifyGo(input, trial.result, trial.parsed);
        if (outcome.status !== 'survived') break;
      }
      rows.push([site.line, outcome.status]);
    }
    return { rows, commands: metrics.commands };
  } finally { session.close(); }
}

test('Go selective runner matches a full-module run with fewer Go commands', async (t) => {
  if (!hasVerifiedGo(t)) return;
  const root = project(t);
  const input = await collectGo({ root, runs: 1 });
  const reference = await fullModuleReference(root, input);
  const metrics = {};
  const mutation = await mutateGo({ root, input, scope: { changed: { 'value.go': '3,5' },
    targeted: ['value_test.go::TestChoose', 'value_test.go::TestIdentity'] },
    config: { mutation: { maxMutants: 10, maxSeconds: 120, seed: 7 } }, metrics });
  assert.deepEqual(mutation.mutants.map((row) => [row.line, row.status]), reference.rows);
  assert.ok(metrics.commands < reference.commands,
    `selective runner used ${metrics.commands} commands; full-module reference used ${reference.commands}`);

  const reuseMetrics = {};
  const reuse = Object.fromEntries(mutation.mutants.map((row) => [row.id, { ...row, reused: true }]));
  const repeated = await mutateGo({ root, input, scope: { changed: { 'value.go': '3,5' }, reuse },
    config: { mutation: { maxMutants: 10, maxSeconds: 120, seed: 7 } }, metrics: reuseMetrics });
  assert.ok(repeated.mutants.every((row) => row.reused));
  assert.equal(reuseMetrics.commands, 2, 'reused faults run no guarded compile or test command');
  assert.equal(readFileSync(join(root, 'value.go'), 'utf8'), readFileSync(join(fixture, 'value.go'), 'utf8'));
});
