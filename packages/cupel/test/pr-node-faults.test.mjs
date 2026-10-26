import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixedEnv, profileRequestSnapshot } from '../src/pr/profiles/node/snapshot.mjs';
import { verifyCoverageProof } from '../src/pr/profiles/node/coverage-proof.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const profile = fileURLToPath(new URL('../src/pr/profiles/node/', import.meta.url));
const scratch = join(repo, '.scratch');
const nodePath = '/opt/homebrew/Cellar/node/26.7.0/bin/node';

function faultRun(fault) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'pr-fault-subject-'));
  const out = mkdtempSync(join(scratch, 'pr-fault-output-'));
  const file = 'tests/a.test.cjs';
  try {
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, file), "const {test}=require('node:test');test('a',()=>{});\n");
    const pre = profileRequestSnapshot({ root, files: [file], version: '26.7.0' });
    writeFileSync(join(out, 'events.jsonl'), '');
    const prelude = join(out, 'fault.cjs');
    writeFileSync(prelude, `const fault=${JSON.stringify(fault)};\nconst fs=require('node:fs');\nconst inspector=require('node:inspector');\nif(fault==='serialize'){const write=fs.writeFileSync;fs.writeFileSync=function(path,...rest){if(String(path).endsWith('/coverage.json'))throw Error('injected serialization failure');return write.call(this,path,...rest)}}\nelse if(fault==='connect'){inspector.Session.prototype.connect=function(){throw Error('injected connect failure')}}\nelse {const post=inspector.Session.prototype.post;inspector.Session.prototype.post=function(method,...rest){if(method===({start:'Profiler.startPreciseCoverage',take:'Profiler.takePreciseCoverage',stop:'Profiler.stopPreciseCoverage'})[fault])throw Error('injected '+fault+' failure');return post.call(this,method,...rest)}}\n`);
    const env = { ...fixedEnv, HOME: out, TMPDIR: out, CUPEL_ROOT: root, CUPEL_OWNER: file,
      CUPEL_INPUT_POLICY: 'strict-v1', CUPEL_INPUTS: JSON.stringify(Object.keys(pre.manifest)),
      CUPEL_INPUT_MANIFEST_HASH: pre.identity.inputManifestHash,
      CUPEL_PROFILE_COVERAGE: 'per-test-v1', CUPEL_PRIVATE_TMP: out, CUPEL_LOCKED_PACKAGES: '[]' };
    const args = ['--permission', '--allow-inspector', '--disable-sigusr1',
      `--allow-fs-read=${root}`, `--allow-fs-read=${profile}`, `--allow-fs-read=${out}`,
      `--allow-fs-write=${out}`, `--require=${prelude}`,
      `--require=${join(profile, 'bootstrap.cjs')}`, '--test',
      '--experimental-test-isolation=none', `--test-reporter=${join(profile, 'reporter.mjs')}`, file];
    const child = spawnSync(nodePath, args, { cwd: root, env, encoding: 'utf8', timeout: 30000 });
    const trace = readFileSync(join(out, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    const proof = existsSync(join(out, 'coverage.json')) ? JSON.parse(readFileSync(join(out, 'coverage.json'), 'utf8')) : null;
    return { child, trace, proof, file, manifestHash: pre.identity.inputManifestHash };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}

for (const fault of ['connect', 'start', 'take', 'stop', 'serialize']) {
  test(`Node 26 ${fault} failure cannot produce accepted coverage`, () => {
    const result = faultRun(fault);
    assert.ok(result.trace.some(row => row.kind === 'coverage-error'),
      `${fault}: ${result.child.stderr}`);
    if (result.proof) assert.throws(() => verifyCoverageProof(result.proof, {
      file: result.file, inputManifestHash: result.manifestHash,
      rows: [{ fullName: 'a', status: 'passed', id: 'a#1' }],
      sources: new Set(),
    }));
    else assert.equal(result.proof, null); // host requires the missing record even if node:test exits 0
  });
}
