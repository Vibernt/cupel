import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSource, PRODUCT_MUTATE_HASH, sha256 } from './pin.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const [runtimePath, casesPath] = process.argv.slice(2).map(value => resolve(value ?? ''));
assert.ok(runtimePath.startsWith(join(repo, '.scratch/s19/runtime-')));
assert.ok(casesPath.startsWith(join(repo, '.scratch/s17/approved9e-node')));
const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'));
const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
assert.equal(cases.runtime, process.version);
const output = mkdtempSync(join(repo, '.scratch/s19/launch-'));
const sha = path => sha256(readFileSync(path));
function verify() {
  assertSource(join(repo, 'packages/cupel/src/mutate'), PRODUCT_MUTATE_HASH);
  assertSource(join(repo, 'packages/cupel/src'), runtime.productClosure.sourceHash);
  assertSource(join(repo, 'packages/cupel/schemas'), runtime.productClosure.schemaHash);
  assert.equal(sha(join(repo, 'packages/cupel/src/engine/lines.mjs')),
    runtime.productClosure.parserHash);
  for (const copy of Object.values(runtime.copies)) {
    const src = join(copy.module, '../..');
    assertSource(join(copy.module, '..'), copy.mutationSourceHash);
    assertSource(src, copy.sourceHash);
    assertSource(join(src, '../schemas'), copy.schemaHash);
    assert.equal(sha(join(src, 'engine/lines.mjs')), copy.parserHash);
  }
  for (const [name, path] of Object.entries(cases.cases)) {
    const item = JSON.parse(readFileSync(path, 'utf8'));
    for (const [file, expected] of Object.entries(cases.fingerprints[name]))
      assert.equal(sha(join(item.root, file)), expected);
  }
}
verify();
const runner = join(repo, 'plans/spikes/s19/diagnostic-runner.mjs');
const preload = join(repo, 'plans/spikes/s17/diagnostic-spawns.cjs');
const rows = {};
for (const [name, casePath] of Object.entries(cases.cases)) {
  const { root } = JSON.parse(readFileSync(casePath, 'utf8'));
  const methods = {};
  for (const mode of ['control', 'instrumented']) {
    verify();
    const countsPath = join(output, `${name}-${mode}-launches.json`);
    const child = spawnSync(process.execPath, ['--require', preload, runner,
      runtime.copies[mode].module, casePath, mode], {
      cwd: repo, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CUPEL_S17_SPAWN_COUNTS: countsPath,
        CUPEL_S17_PROJECT_ROOT: root, NO_COLOR: '1' },
    });
    writeFileSync(join(output, `${name}-${mode}-run.json`), JSON.stringify({
      status: child.status, signal: child.signal, error: child.error?.message ?? null,
      stdout: child.stdout, stderr: child.stderr }, null, 2) + '\n');
    assert.ifError(child.error);
    assert.equal(child.status, 0, `${name}/${mode}: ${child.stderr}`);
    const call = JSON.parse(child.stdout);
    const launches = JSON.parse(readFileSync(countsPath, 'utf8'));
    const jobLogs = call.logs.filter(line => /with \d+ processes$/.test(line));
    assert.equal(jobLogs.length, 1, `${name}/${mode}: actual jobs log missing`);
    methods[mode] = { call, launches, actualJobs: Number(jobLogs[0].match(/with (\d+) processes$/)[1]),
      jobLog: jobLogs[0] };
    verify();
  }
  for (const key of ['mutation', 'confirmed', 'counts', 'metrics', 'confirmationMetrics'])
    assert.deepEqual(methods.control.call[key], methods.instrumented.call[key],
      `${name}: ${key} changed in diagnostic`);
  for (const key of ['test', 'jest', 'validity', 'other'])
    assert.equal(methods.control.launches[key], methods.instrumented.launches[key],
      `${name}: ${key} launches changed`);
  assert.equal(methods.control.actualJobs, methods.instrumented.actualJobs);
  rows[name] = { casePath, caseSha256: sha(casePath),
    counts: methods.control.call.counts,
    outcomeSha256: sha256(JSON.stringify([methods.control.call.mutation,
      methods.control.call.confirmed])),
    actualJobs: methods.control.actualJobs,
    jobLog: methods.control.jobLog,
    launches: { control: methods.control.launches, instrumented: methods.instrumented.launches } };
  process.stdout.write(`${name}: exact full outcomes and launch counts; ${rows[name].jobLog}\n`);
}
verify();
const result = { version: 'cupel-s19-launch-diagnostic/1', runtime: process.version,
  runtimeManifest: runtimePath, acceptedCases: casesPath,
  note: 'Untimed diagnostic preload; excluded from whole-call denominator', rows };
writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(`${join(output, 'result.json')}\n`);
