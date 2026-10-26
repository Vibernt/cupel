import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutate } from '../src/cli/collect.mjs';
import { mutateRuby } from '../src/cli/native-mutation.mjs';
import { mergeRunners } from '../src/cli/merge-runners.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const bin = join(repo, 'packages/cupel/bin/cupel.mjs');
const sample = JSON.parse(readFileSync(join(repo, 'spec/conformance/cases/001-report-minimal/input.json'), 'utf8'));
const scratch = join(repo, '.scratch');
const quiet = () => {};

function withRoot(run) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'mutation-capabilities-'));
  try { return run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function externalFixture(root, runner, runtime = 'node') {
  const input = { ...sample, runtime: { ...sample.runtime, name: runtime } };
  const stub = join(root, 'collector.mjs');
  writeFileSync(stub, `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[process.argv.indexOf('--out') + 1], ${JSON.stringify(JSON.stringify(input))});\n`);
  writeFileSync(join(root, 'cupel.json'), JSON.stringify({ runners: { [runner]: { collector: `"${process.execPath}" "${stub}"` } } }));
  return stub;
}

function cli(root, args) {
  return spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
}

function git(root, ...args) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
}

test('live report and evidence refuse unsupported and unknown custom runners; explicit coverage-only mode remains available', () => withRoot((root) => {
  for (const [runner, runtime] of [['custom-rust', 'rust'], ['custom', 'node']]) {
    externalFixture(root, runner, runtime);
    for (const command of [['report'], ['report', '--evidence']]) {
      const result = cli(root, [...command, '--runs', '1']);
      assert.equal(result.status, 3, `${runner} ${command.join(' ')}: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(`runner ${runner}.*mutation is not implemented`));
    }
    const coverage = cli(root, ['report', '--no-mutation', '--runs', '1']);
    assert.equal(coverage.status, 0, `${runner}: ${coverage.stderr}`);
  }
}));

test('live guard refuses unsupported base and head collection; saved inputs remain pure engine data', () => withRoot((root) => {
  externalFixture(root, 'cargo', 'rust');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', 'cupel.json', 'collector.mjs');
  git(root, 'commit', '-q', '-m', 'fixture', '-m', 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
  const live = cli(root, ['guard', '--base', 'HEAD', '--runs', '1']);
  assert.equal(live.status, 3, live.stderr);
  assert.match(live.stderr, /runner cargo.*unsupported custom mutation configuration/);
  const saved = join(root, 'saved.json');
  writeFileSync(saved, JSON.stringify(sample));
  const head = cli(root, ['guard', '--base-input', saved, '--runs', '1']);
  assert.equal(head.status, 3, head.stderr);
  assert.match(head.stderr, /runner cargo.*unsupported custom mutation configuration/);
  const base = cli(root, ['guard', '--base', 'HEAD', '--head-input', saved, '--runs', '1']);
  assert.equal(base.status, 3, base.stderr);
  assert.match(base.stderr, /runner cargo.*unsupported custom mutation configuration/);
  const pure = cli(root, ['guard', '--base-input', saved, '--head-input', saved]);
  assert.equal(pure.status, 0, pure.stderr);
}));

test('mixed live mutation preflights all requested runners before calling any mutator', async () => {
  const node = structuredClone(sample);
  const cargo = structuredClone(sample);
  cargo.runtime.name = 'rust';
  cargo.tests = cargo.tests.map((item) => ({ ...item, id: `cargo/${item.id}` }));
  cargo.coverage.byTest = Object.fromEntries(Object.entries(cargo.coverage.byTest ?? {}).map(([id, value]) => [`cargo/${id}`, value]));
  const input = mergeRunners([{ name: 'node', input: node }, { name: 'cargo', input: cargo }]);
  let called = 0;
  const mutator = { async mutateNode() { called += 1; return { mutants: [], targeted: [] }; } };
  await assert.rejects(mutate(mutator, { root: scratch, cfg: { runners: { node: {}, cargo: { collector: 'unapproved' } } }, input,
    scope: { critical: true }, log: quiet }), /runner cargo.*unsupported custom mutation configuration/);
  assert.equal(called, 0);
});

test('mixed live report refuses coverage-only output from one unsupported runner', () => withRoot((root) => {
  const outputs = {};
  for (const name of ['node', 'cargo']) {
    const part = structuredClone(sample);
    if (name === 'cargo') part.runtime.name = 'rust';
    part.tests = part.tests.map((item) => ({ ...item, id: `${name}/${item.id}` }));
    part.coverage.byTest = Object.fromEntries(Object.entries(part.coverage.byTest ?? {}).map(([id, value]) => [`${name}/${id}`, value]));
    const stub = join(root, `${name}-collector.mjs`);
    writeFileSync(stub, `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[process.argv.indexOf('--out') + 1], ${JSON.stringify(JSON.stringify(part))});\n`);
    outputs[name] = { collector: `"${process.execPath}" "${stub}"` };
  }
  writeFileSync(join(root, 'cupel.json'), JSON.stringify({ runners: outputs }));
  const live = cli(root, ['report', '--evidence', '--runs', '1']);
  assert.equal(live.status, 3, live.stderr);
  assert.match(live.stderr, /runner cargo.*unsupported custom mutation configuration/);
  const coverage = cli(root, ['report', '--no-mutation', '--runs', '1']);
  assert.equal(coverage.status, 0, coverage.stderr);
}));

test('a known runner cannot claim mutation support for another runtime', async () => {
  const input = { ...sample, runtime: { ...sample.runtime, name: 'go' } };
  let called = 0;
  const mutator = { async mutateNode() { called += 1; return { mutants: [], targeted: [] }; } };
  await assert.rejects(mutate(mutator, { root: scratch, cfg: { runners: { node: {} } }, input,
    scope: { critical: true }, log: quiet }), /runner node.*runtime go.*mutation is not implemented/);
  assert.equal(called, 0);
  await assert.rejects(mutate(mutator, { root: scratch, cfg: { runners: { go: {} } },
    input: { ...sample, runtime: { name: 'ruby', version: '4.0.7' } },
    scope: { critical: true }, log: quiet }), /runner go.*runtime ruby.*mutation is not implemented/);
  assert.equal(called, 0);
});

test('Ruby mutation requires an explicit collector command ending in collect', () => {
  assert.throws(() => mutateRuby({ runner: { name: 'minitest', collector: 'ruby custom.rb' },
    root: scratch, cfg: {}, input: sample, scope: { critical: true } }),
    /collector command must end in collect/);
});
