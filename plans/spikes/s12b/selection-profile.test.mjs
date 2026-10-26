import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inject } from '../s12/fixtures.mjs';
import { digest, makeBundle, NODE_PROFILE, verifyCollectorParity, verifyRunParity } from './evidence.mjs';
import { withFixture } from './fixture-support.mjs';
import { assessHeadTrace, selectAcrossRunners, selectS12b } from './selection.mjs';

test('ordinary versus constrained full parity requires exact IDs, files and statuses', () => {
  const rows = [{ id: 'tests/a.test.mjs::first', file: 'tests/a.test.mjs', status: 'passed' },
    { id: 'tests/b.test.mjs::second', file: 'tests/b.test.mjs', status: 'passed' }];
  assert.equal(verifyRunParity(rows, [...rows].reverse()), null);
  assert.match(verifyRunParity(rows, rows.slice(0, 1)), /differ/);
  assert.match(verifyRunParity(rows, [{ ...rows[0], status: 'failed' }, rows[1]]), /differ/);
  assert.match(verifyRunParity(rows, [{ ...rows[0], file: 'tests/other.test.mjs' }, rows[1]]), /differ/);
  assert.match(verifyRunParity(rows, [rows[0], rows[0]]), /duplicate/);
});

test('collector baseline binds to ordinary profile test inventory', () => {
  const input = [{ file: 'tests/a.test.mjs', name: 'first', status: 'passed' }];
  const ordinary = [{ file: 'tests/a.test.mjs', id: 'first#1', status: 'passed' }];
  assert.equal(verifyCollectorParity(input, ordinary), null);
  assert.match(verifyCollectorParity(input, [{ ...ordinary[0], id: 'other#1' }]), /differ/);
  assert.match(verifyCollectorParity([...input, { ...input[0] }], ordinary), /duplicate test names/);
});

function profileCase(f) {
  const args = { ...f.args, runtime: '26.7.0', executionPolicy: NODE_PROFILE,
    environmentPolicy: { ...f.args.environmentPolicy, runtimeHash: 'test-runtime-hash' } };
  const sidecar = structuredClone(f.sidecar);
  sidecar.runtime.version = '26.7.0';
  sidecar.execution.mode = 'baseline';
  sidecar.execution.inputPolicy = 'strict-v1';
  sidecar.execution.opaqueRootNpmrc = 'absent';
  sidecar.execution.isolation = NODE_PROFILE;
  sidecar.execution.profile = NODE_PROFILE;
  sidecar.execution.environmentPolicyHash = digest(args.environmentPolicy);
  sidecar.execution.profileRuntimeHash = 'test-runtime-hash';
  sidecar.execution.inputManifestHash = digest(Object.fromEntries(
    Object.entries(f.bundle.core.identity.files).map(([path, hash]) => [path, `sha256:${hash}`])));
  sidecar.execution.dependencyLockHash = null;
  sidecar.dependencies = { lockHash: null, files: {} };
  sidecar.nativeTypeScript = { files: {} };
  sidecar.denials = [];
  for (const row of Object.values(sidecar.files)) {
    row.capabilities.push('readonly-boundary', 'unsupported-controls',
      'fs-invocation-origin', 'results-parity');
    row.filesystemEvents = ['reads', 'probes', 'directories', 'writes'].flatMap(channel =>
      row[channel].map(path => ({ channel, path, operation: channel, origin: 'application' })));
  }
  sidecar.global.filesystemEvents = [];
  return { args, sidecar };
}

test('node readonly profile requires exact runtime, capabilities and sole-runner scope', () => withFixture(f => {
  const { args, sidecar } = profileCase(f);
  const bundle = makeBundle({ ...args, input: f.bundle.core.input, sidecar });
  const decision = selectS12b({ ...args, bundle });
  assert.equal(decision.kind, 'selected');
  assert.match(selectS12b({ ...args, inputPolicy: 'express-root-npmrc-opaque-v1', bundle }).reason,
    /inputPolicy identity differs/);
  assert.match(selectS12b({ ...args, inputPolicy: 'unrecognized-policy', bundle }).reason,
    /unsupported input privacy policy/);
  const wrongPolicy = structuredClone(sidecar);
  wrongPolicy.execution.inputPolicy = 'express-root-npmrc-opaque-v1';
  assert.throws(() => makeBundle({ ...args, input: f.bundle.core.input, sidecar: wrongPolicy }),
    /input privacy policy differs/);
  const wrongDescriptor = structuredClone(sidecar);
  wrongDescriptor.execution.opaqueRootNpmrc = 'regular';
  assert.throws(() => makeBundle({ ...args, input: f.bundle.core.input, sidecar: wrongDescriptor }),
    /opaque root \.npmrc descriptor differs/);
  assert.match(selectS12b({ ...args, runtime: '25.0.0', bundle }).reason, /runtime/);
  assert.match(selectAcrossRunners([{ ...args, bundle }, { ...f.args, bundle: f.bundle }]).reason,
    /cannot mix/);
  const weak = structuredClone(sidecar);
  weak.files['tests/core.test.mjs'].capabilities.splice(-1);
  assert.throws(() => makeBundle({ ...args, input: f.bundle.core.input, sidecar: weak }), /results-parity/);
  const external = structuredClone(sidecar);
  external.files['tests/core.test.mjs'].reads.push('/probe/reporter.mjs');
  assert.throws(() => makeBundle({ ...args, input: f.bundle.core.input, sidecar: external }), /noncanonical path/);
  const staleManifest = structuredClone(sidecar);
  staleManifest.execution.inputManifestHash = 'bad';
  assert.throws(() => makeBundle({ ...args, input: f.bundle.core.input, sidecar: staleManifest }), /input manifest/);
  const staleRuntime = structuredClone(sidecar);
  staleRuntime.execution.profileRuntimeHash = 'bad';
  assert.throws(() => makeBundle({ ...args, input: f.bundle.core.input, sidecar: staleRuntime }), /runtime source identity/);
  const staleLock = structuredClone(sidecar);
  staleLock.dependencies.lockHash = 'bad';
  assert.throws(() => makeBundle({ ...args, input: f.bundle.core.input, sidecar: staleLock }), /dependency lock/);
  const caughtDenial = structuredClone(sidecar);
  caughtDenial.files = Object.fromEntries(decision.files.map(file => [file, caughtDenial.files[file]]));
  caughtDenial.completion.expectedFiles = decision.files;
  caughtDenial.completion.finishedFiles = decision.files;
  caughtDenial.global.unsupported.push('caught-forbidden-module');
  assert.match(assessHeadTrace({ ...args, decision, sidecar: caughtDenial }).reason, /caught-forbidden-module/);
  const denialOnly = structuredClone(caughtDenial);
  denialOnly.global.unsupported = [];
  denialOnly.denials.push({ file: decision.files[0], marker: 'caught-forbidden-module' });
  assert.match(assessHeadTrace({ ...args, decision, sidecar: denialOnly }).reason, /persistent denials/);
  const selectedHead = structuredClone(sidecar);
  selectedHead.files = Object.fromEntries(decision.files.map(file => [file, selectedHead.files[file]]));
  selectedHead.completion.expectedFiles = decision.files;
  selectedHead.completion.finishedFiles = decision.files;
  selectedHead.execution.mode = 'selected-head';
  selectedHead.execution.baselineConfigHash = bundle.sidecar.execution.configHash;
  for (const row of Object.values(selectedHead.files)) {
    row.capabilities = row.capabilities.filter(cap => cap !== 'results-parity');
    row.capabilities.push('baseline-parity-bound');
  }
  assert.equal(assessHeadTrace({ ...args, decision, sidecar: selectedHead,
    bundle, mode: 'selected-head' }).kind, 'accepted');
  selectedHead.execution.baselineConfigHash = 'bad';
  assert.match(assessHeadTrace({ ...args, decision, sidecar: selectedHead,
    bundle, mode: 'selected-head' }).reason, /baseline parity/);
  selectedHead.execution.baselineConfigHash = bundle.sidecar.execution.configHash;
  writeFileSync(join(f.args.headRoot, 'src/core.mjs'), 'export const changedAfterSelection = 1;\n');
  assert.match(assessHeadTrace({ ...args, decision, sidecar: selectedHead,
    bundle, mode: 'selected-head' }).reason, /input manifest differs/);
}));

test('opaque .npmrc profile binds the same policy and descriptor at selected head', () => withFixture(f => {
  writeFileSync(join(f.args.baseRoot, '.npmrc'), 'dummy fixture only\n');
  writeFileSync(join(f.args.headRoot, '.npmrc'), 'changed dummy fixture only\n');
  const { args, sidecar } = profileCase(f);
  args.inputPolicy = 'express-root-npmrc-opaque-v1';
  args.config = { ...args.config, inputPolicy: args.inputPolicy, opaqueRootNpmrc: 'regular' };
  args.environmentPolicy = { ...args.environmentPolicy,
    inputPolicy: args.inputPolicy, opaqueRootNpmrc: 'regular' };
  sidecar.execution.inputPolicy = args.inputPolicy;
  sidecar.execution.opaqueRootNpmrc = 'regular';
  sidecar.execution.configHash = digest(args.config);
  sidecar.execution.environmentPolicyHash = digest(args.environmentPolicy);
  const guardFiles = [...sidecar.completion.expectedFiles];
  sidecar.fullReferenceGuard = { mode: 'privacy-guarded', policy: args.inputPolicy,
    expectedFiles: guardFiles, finishedFiles: guardFiles, errors: [], denials: [] };
  for (const row of Object.values(sidecar.files)) row.capabilities.push('privacy-guarded-full');
  const missingGuard = structuredClone(sidecar);
  delete missingGuard.fullReferenceGuard;
  assert.throws(() => makeBundle({ ...args, input: f.bundle.core.input,
    sidecar: missingGuard }), /ordinary full privacy guard proof incomplete/);
  const truncatedGuard = structuredClone(sidecar);
  truncatedGuard.fullReferenceGuard.finishedFiles.pop();
  assert.throws(() => makeBundle({ ...args, input: f.bundle.core.input,
    sidecar: truncatedGuard }), /ordinary full privacy guard proof incomplete/);
  const caughtDenial = structuredClone(sidecar);
  caughtDenial.fullReferenceGuard.denials.push('caught .npmrc read');
  assert.throws(() => makeBundle({ ...args, input: f.bundle.core.input,
    sidecar: caughtDenial }), /ordinary full privacy guard proof incomplete/);
  const spoofedPolicy = structuredClone(sidecar);
  spoofedPolicy.fullReferenceGuard.policy = 'strict-v1';
  assert.throws(() => makeBundle({ ...args, input: f.bundle.core.input,
    sidecar: spoofedPolicy }), /ordinary full privacy guard proof incomplete/);
  const bundle = makeBundle({ ...args, input: f.bundle.core.input, sidecar });
  const decision = selectS12b({ ...args, bundle });
  assert.equal(decision.kind, 'selected');
  const selectedHead = structuredClone(sidecar);
  selectedHead.files = Object.fromEntries(decision.files.map(file => [file, selectedHead.files[file]]));
  selectedHead.completion.expectedFiles = decision.files;
  selectedHead.completion.finishedFiles = decision.files;
  selectedHead.execution.mode = 'selected-head';
  selectedHead.execution.baselineConfigHash = bundle.sidecar.execution.configHash;
  for (const row of Object.values(selectedHead.files)) {
    row.capabilities = row.capabilities.filter(cap => cap !== 'results-parity');
    row.capabilities.push('baseline-parity-bound', 'baseline-privacy-bound');
  }
  assert.equal(assessHeadTrace({ ...args, decision, sidecar: selectedHead,
    bundle, mode: 'selected-head' }).kind, 'accepted');
  const missingHeadProof = structuredClone(selectedHead);
  missingHeadProof.files[decision.files[0]].capabilities =
    missingHeadProof.files[decision.files[0]].capabilities.filter(cap =>
      cap !== 'baseline-privacy-bound');
  assert.match(assessHeadTrace({ ...args, decision, sidecar: missingHeadProof,
    bundle, mode: 'selected-head' }).reason, /baseline-privacy-bound/);
  const tamperedBundle = structuredClone(bundle);
  tamperedBundle.sidecar.fullReferenceGuard.denials.push('caught read');
  assert.match(assessHeadTrace({ ...args, decision, sidecar: selectedHead,
    bundle: tamperedBundle, mode: 'selected-head' }).reason, /baseline privacy guard proof differs/);
  assert.match(assessHeadTrace({ ...args, inputPolicy: 'strict-v1', decision, sidecar: selectedHead,
    bundle, mode: 'selected-head' }).reason, /private input path|input privacy policy differs/);
  selectedHead.execution.opaqueRootNpmrc = 'absent';
  assert.match(assessHeadTrace({ ...args, decision, sidecar: selectedHead,
    bundle, mode: 'selected-head' }).reason, /opaque root \.npmrc descriptor differs/);
}));

test('loader reads stay exact deps while application and unknown calls trigger broad observers', () => withFixture(f => {
  const { args, sidecar } = profileCase(f);
  const row = sidecar.files['tests/independent.test.mjs'];
  row.imports.push('src/core.mjs');
  row.reads.push('src/core.mjs');
  row.filesystemEvents.push({ channel: 'reads', path: 'src/core.mjs',
    operation: 'readFileSync', origin: 'loader' });
  inject(f.args.headRoot, 'node', 'shared-setup');
  const loaderOnly = makeBundle({ ...args, input: f.bundle.core.input, sidecar });
  const selected = selectS12b({ ...args, bundle: loaderOnly });
  assert.equal(selected.kind, 'selected');
  assert.ok(selected.files.length < 8);
  assert.ok(!selected.files.includes('tests/independent.test.mjs'));
  row.filesystemEvents.push({ channel: 'reads', path: 'src/core.mjs',
    operation: 'readFileSync', origin: 'application' });
  const explicitRead = makeBundle({ ...args, input: f.bundle.core.input, sidecar });
  assert.ok(selectS12b({ ...args, bundle: explicitRead }).files.includes('tests/independent.test.mjs'));
  row.filesystemEvents.at(-1).origin = 'unknown';
  const unknown = makeBundle({ ...args, input: f.bundle.core.input, sidecar });
  assert.ok(selectS12b({ ...args, bundle: unknown }).files.includes('tests/independent.test.mjs'));
  row.filesystemEvents.pop(); row.filesystemEvents.pop();
  assert.throws(() => makeBundle({ ...args, input: f.bundle.core.input, sidecar }),
    /differs from invocation provenance/);
}));
