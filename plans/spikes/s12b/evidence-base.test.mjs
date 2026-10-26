import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPAQUE_NPMRC_POLICY, safeFileInventory, safeInputSnapshot } from './evidence-base.mjs';
import { withFixture } from './fixture-support.mjs';
import { makeBundle } from './evidence.mjs';
import { selectS12b } from './selection.mjs';

test('private filename refusal precedes every content read', () => {
  for (const name of ['.env', '.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials',
    'id_rsa', 'id_ed25519', 'application_default_credentials.json', 'credentials.db']) {
    const root = mkdtempSync('/tmp/cupel-s12b-private-');
    try {
      writeFileSync(join(root, 'public.mjs'), 'export const n = 1;\n');
      writeFileSync(join(root, name), 'dummy fixture only\n');
      let reads = 0;
      assert.throws(() => safeFileInventory(root, { readFile: () => {
        reads += 1; throw new Error('content read must not happen');
      } }), /private input path/);
      assert.equal(reads, 0, `read occurred before refusing ${name}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('bundle creation and direct selection refuse private inputs', () => {
  withFixture(f => {
    writeFileSync(join(f.args.baseRoot, '.env'), 'dummy fixture only\n');
    assert.throws(() => makeBundle({ ...f.args, input: f.bundle.core.input,
      sidecar: f.sidecar }), /private input path/);
  });
  withFixture(f => {
    writeFileSync(join(f.args.headRoot, '.env'), 'dummy fixture only\n');
    const decision = selectS12b({ ...f.args, bundle: f.bundle });
    assert.equal(decision.kind, 'refuse');
    assert.match(decision.reason, /private input path/);
  });
});

test('approved root .npmrc is opaque and policy-bound across base and head', () => withFixture(f => {
  const baseNpmrc = join(f.args.baseRoot, '.npmrc');
  const headNpmrc = join(f.args.headRoot, '.npmrc');
  writeFileSync(baseNpmrc, 'dummy fixture only\n');
  writeFileSync(headNpmrc, 'changed dummy fixture only\n');
  const readPaths = [];
  const snapshot = safeInputSnapshot(f.args.baseRoot, { inputPolicy: OPAQUE_NPMRC_POLICY,
    readFile: path => { readPaths.push(path); return Buffer.from('public fixture only'); } });
  assert.equal(snapshot.opaqueRootNpmrc, 'regular');
  assert.equal(Object.hasOwn(snapshot.files, '.npmrc'), false);
  assert.equal(readPaths.some(path => path.endsWith('/.npmrc')), false);
  assert.throws(() => safeFileInventory(f.args.baseRoot), /private input path/);
  const bundle = makeBundle({ ...f.args, inputPolicy: OPAQUE_NPMRC_POLICY,
    input: f.bundle.core.input, sidecar: f.sidecar });
  assert.equal(bundle.binding.inputPolicy, OPAQUE_NPMRC_POLICY);
  assert.equal(bundle.binding.opaqueRootNpmrc, 'regular');
  const decision = selectS12b({ ...f.args, inputPolicy: OPAQUE_NPMRC_POLICY, bundle });
  assert.equal(decision.kind, 'selected');
  assert.match(selectS12b({ ...f.args, bundle }).reason, /private input path/);
  unlinkSync(headNpmrc);
  assert.match(selectS12b({ ...f.args, inputPolicy: OPAQUE_NPMRC_POLICY, bundle }).reason,
    /presence differs/);
  writeFileSync(headNpmrc, 'dummy fixture only\n');
  writeFileSync(join(f.args.headRoot, '.env'), 'dummy fixture only\n');
  assert.match(selectS12b({ ...f.args, inputPolicy: OPAQUE_NPMRC_POLICY, bundle }).reason,
    /private input path/);
}));
