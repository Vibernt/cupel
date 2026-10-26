import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OPAQUE_NPMRC_POLICY } from '../s12b/evidence-base.mjs';
import { verifyRunParity } from '../s12b/evidence.mjs';
import { nodeProfilePolicy } from '../s12b/evidence-node-context.mjs';
import { captureNodeProfile } from '../s12b/node-profile/launch.mjs';
import { runOpaqueFull } from '../s12b/node-profile/opaque-full.mjs';
import { assessHeadTrace } from '../s12b/selection.mjs';
import { reporterRows } from './oracle.mjs';
import { outcome } from './matrix-support.mjs';

const profile = resolve(import.meta.dirname, '../s12b/node-profile');
const fixedEnv = { CI: '1', NO_COLOR: '1', TZ: 'UTC', LANG: 'C' };

export function fullOracle({ root, files, out, nodePath, inputPolicy }) {
  mkdirSync(out);
  const ordinary = inputPolicy === OPAQUE_NPMRC_POLICY ? runOpaqueFull({
    nodePath, root, here: profile, files, out, env: fixedEnv,
  }) : (() => {
    const result = spawnSync(nodePath, ['--test',
      `--test-reporter=${join(profile, 'reporter.mjs')}`, ...files],
    { cwd: root, env: fixedEnv, encoding: 'utf8', timeout: 30000,
      maxBuffer: 8 << 20 });
    return { result, proof: null };
  })();
  writeFileSync(join(out, 'ordinary.jsonl'), ordinary.result.stdout ?? '');
  writeFileSync(join(out, 'ordinary.stderr'), ordinary.result.stderr ?? '');
  if (ordinary.result.error) throw ordinary.result.error;
  if (inputPolicy === OPAQUE_NPMRC_POLICY) {
    const guard = ordinary.proof;
    assert.equal(guard.mode, 'privacy-guarded');
    assert.deepEqual(guard.expectedFiles, files);
    assert.deepEqual(guard.finishedFiles, files);
    assert.deepEqual(guard.errors, []);
    assert.deepEqual(guard.denials, []);
    writeFileSync(join(out, 'guard.json'), JSON.stringify(guard, null, 2) + '\n');
  }
  const rows = reporterRows(ordinary.result.stdout ?? '', root, files);
  assert.equal(ordinary.result.status === 0, outcome(rows) === 'pass',
    'full exit/status mismatch');
  return { rows, exit: ordinary.result.status, privacyGuarded: !!ordinary.proof };
}

export function verifiedCapture({ root, files, out, nodePath, inputPolicy }) {
  const capture = captureNodeProfile({ root, files, out, nodePath, inputPolicy });
  assert.equal(capture.constrainedFull.parity, true, 'ordinary/constrained full parity');
  assert.equal(verifyRunParity(capture.ordinaryFull.rows, capture.constrainedFull.rows), null);
  assert.deepEqual(capture.sidecar.global.unsupported, []);
  assert.deepEqual(capture.sidecar.denials, []);
  assert.deepEqual(capture.sidecar.completion.errors, []);
  if (inputPolicy === OPAQUE_NPMRC_POLICY) {
    assert.equal(capture.ordinaryFull.privacyGuarded, true);
    assert.deepEqual(capture.sidecar.fullReferenceGuard.errors, []);
    assert.deepEqual(capture.sidecar.fullReferenceGuard.denials, []);
    assert.deepEqual(capture.sidecar.fullReferenceGuard.finishedFiles, files);
  }
  return capture;
}

export function selectedOld({ root, files, fullFiles, out, bundle,
  baselineArgs, version, inputPolicy, nodePath }) {
  const policy = nodeProfilePolicy({ root, files: fullFiles, version, inputPolicy });
  const baseline = bundle.sidecar;
  const binding = { baselineConfigHash: baseline.execution.configHash,
    baselineParity: true,
    ...(inputPolicy === OPAQUE_NPMRC_POLICY ? { baselinePrivacyGuardedFull: true } : {}),
    headConfigHash: policy.identity.configHash,
    environmentPolicyHash: policy.identity.environmentPolicyHash,
    dependencyLockHash: policy.identity.dependencyLockHash,
    profileRuntimeHash: policy.identity.profileRuntimeHash,
    dependencyEvidence: baseline.dependencies.files };
  const capture = captureNodeProfile({ mode: 'selected-head', root, files, fullFiles,
    out, nodePath, inputPolicy, binding });
  const assessment = assessHeadTrace({ ...baselineArgs, ...policy, headRoot: root,
    decision: { kind: 'selected', files }, sidecar: capture.sidecar, bundle,
    mode: 'selected-head' });
  assert.equal(assessment.kind, 'accepted', assessment.reason);
  assert.equal(capture.ordinaryFull, null, 'old selected must not run hidden full');
  assert.equal(capture.constrainedFull.parity, null);
  return capture;
}
