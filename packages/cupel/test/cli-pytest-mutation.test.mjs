import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const bin = fileURLToPath(new URL('../bin/cupel.mjs', import.meta.url));
const sample = JSON.parse(readFileSync(new URL('../../../spec/conformance/cases/001-report-minimal/input.json', import.meta.url)));

test('report invokes the pytest mutation command and merges its input.mutation', () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch', 'cli-pymut-test-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
    const input = { ...sample, runtime: { name: 'python', version: '3.14' } };
    const script = join(root, 'runner.mjs');
    const trace = join(root, 'trace.json');
    writeFileSync(script, `import { readFileSync, writeFileSync } from 'node:fs';
const action = process.argv[2];
const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const input = ${JSON.stringify(input)};
if (action === 'collect') writeFileSync(value('--out'), JSON.stringify(input));
if (action === 'mutate') {
  const scope = JSON.parse(readFileSync(value('--scope'), 'utf8'));
  writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ action, scope }));
  writeFileSync(value('--out'), JSON.stringify({ ...input, mutation: { mutants: [], targeted: [], seed: 123, sampled: false } }));
}
if (!['collect', 'mutate'].includes(action)) process.exit(4);
`);
    writeFileSync(join(root, 'cupel.json'), JSON.stringify({
      runners: { pytest: { collector: `"${process.execPath}" "${script}" collect` } },
      tiers: { critical: ['src/a.mjs'] },
      mutation: { critical: true, changedLines: false, targeted: false },
    }));
    const output = join(root, 'out.json');
    const run = spawnSync(process.execPath, [bin, 'report', '--runs', '1', '--out', output, '--json'], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).mutation.seed, 123);
    assert.deepEqual(JSON.parse(readFileSync(trace, 'utf8')), { action: 'mutate', scope: { critical: true, changed: null } });
    const base = join(root, 'base.json');
    writeFileSync(base, JSON.stringify(input));
    const check = spawnSync(process.execPath, [bin, 'check', 't1', '--base-input', base, '--runs', '1', '--json'], { cwd: root, encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    assert.equal(JSON.parse(readFileSync(trace, 'utf8')).action, 'mutate');
    const guard = spawnSync(process.execPath, [bin, 'guard', '--base-input', base, '--runs', '1', '--json'], { cwd: root, encoding: 'utf8' });
    assert.equal(guard.status, 0, guard.stderr);
    assert.equal(JSON.parse(readFileSync(trace, 'utf8')).action, 'mutate');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('report --evidence passes target unit ids to pytest mutation', () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch', 'cli-pyevidence-test-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
    const input = { ...sample, runtime: { name: 'python', version: '3.14' }, coverage: {
      ...sample.coverage, byTest: { t1: { 'src/a.mjs': '1-3' }, t2: { 'src/a.mjs': '1-3' } }, setup: { 'tests/a.test.mjs': {} },
    } };
    const script = join(root, 'runner.mjs');
    const trace = join(root, 'trace.json');
    writeFileSync(script, `import { readFileSync, writeFileSync } from 'node:fs';
const action = process.argv[2];
const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const input = ${JSON.stringify(input)};
if (action === 'collect') {
  const targets = process.argv.flatMap((arg, i) => arg === '--recheck' ? [process.argv[i + 1]] : []);
  input.coverage.rechecked = targets;
  writeFileSync(value('--out'), JSON.stringify(input));
}
if (action === 'mutate') {
  const scope = JSON.parse(readFileSync(value('--scope'), 'utf8'));
  writeFileSync(${JSON.stringify(trace)}, JSON.stringify(scope));
  writeFileSync(value('--out'), JSON.stringify({ ...input, mutation: { mutants: [], targeted: scope.targeted, seed: 1, sampled: false } }));
}
if (!['collect', 'mutate'].includes(action)) process.exit(4);
`);
    writeFileSync(join(root, 'cupel.json'), JSON.stringify({
      runners: { pytest: { collector: `"${process.execPath}" "${script}" collect` } },
      mutation: { critical: false, changedLines: false, targeted: true },
    }));
    const output = join(root, 'out.json');
    const run = spawnSync(process.execPath, [bin, 'report', '--runs', '1', '--evidence', '--out', output, '--json'], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(readFileSync(trace, 'utf8')).targeted, ['t1', 't2']);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).mutation.targeted, ['t1', 't2']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('guard confirms a Python survivor that was detected at base', () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch', 'cli-pyconfirm-test-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
    const input = { ...sample, runtime: { name: 'python', version: '3.14' } };
    const id = 'src/a.mjs:2:1:cmp-flip:12345678';
    const mutant = { id, source: 'src/a.mjs', line: 2, operator: 'cmp-flip' };
    const base = join(root, 'base.json');
    writeFileSync(base, JSON.stringify({ ...input, mutation: { mutants: [{ ...mutant, status: 'killed', killedBy: ['t1'] }], targeted: [], seed: 1, sampled: false } }));
    const trace = join(root, 'confirmed.json');
    const script = join(root, 'runner.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs';
const action = process.argv[2];
const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const input = ${JSON.stringify(input)};
const mutant = ${JSON.stringify(mutant)};
if (action === 'collect') writeFileSync(value('--out'), JSON.stringify(input));
if (action === 'mutate') writeFileSync(value('--out'), JSON.stringify({ ...input, mutation: { mutants: [{ ...mutant, status: 'survived' }], targeted: [], seed: 1, sampled: false } }));
if (action === 'confirm') {
  writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ ids: process.argv.slice(process.argv.indexOf('--ids') + 1, process.argv.indexOf('--out')) }));
  writeFileSync(value('--out'), JSON.stringify({ mutants: [{ ...mutant, status: 'killed', killedBy: ['t1'] }], targeted: [], seed: 1, sampled: false }));
}
if (!['collect', 'mutate', 'confirm'].includes(action)) process.exit(4);
`);
    writeFileSync(join(root, 'cupel.json'), JSON.stringify({
      runners: { pytest: { collector: `"${process.execPath}" "${script}" collect` } },
      tiers: { critical: ['src/a.mjs'] },
      mutation: { critical: true, changedLines: false, targeted: false },
    }));
    const run = spawnSync(process.execPath, [bin, 'guard', '--base-input', base, '--runs', '1', '--json'], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(readFileSync(trace, 'utf8')), { ids: [id] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
