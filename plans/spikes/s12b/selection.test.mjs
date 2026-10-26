import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inject } from '../s12/fixtures.mjs';
import { digest, makeBundle } from './evidence.mjs';
import { fixture, withFixture } from './fixture-support.mjs';
import { assessHeadTrace, selectAcrossRunners, selectS12b } from './selection.mjs';

test('text pin is selected through an observed read beside unrelated executable coverage', () => withFixture(f => {
  inject(f.args.headRoot, 'node', 'source-text-pin');
  const decision = selectS12b({ ...f.args, bundle: f.bundle });
  assert.equal(decision.kind, 'selected');
  assert.ok(decision.files.includes('tests/text.test.mjs'));
  assert.ok(decision.files.includes('tests/text-runtime.test.mjs'));
}));

test('all application filesystem observers join any code change', () => withFixture(f => {
  inject(f.args.headRoot, 'node', 'ordinary-source');
  const decision = selectS12b({ ...f.args, bundle: f.bundle });
  assert.equal(decision.kind, 'selected');
  assert.ok(decision.files.includes('tests/config.test.mjs'));
  assert.ok(decision.files.includes('tests/text.test.mjs'));
  assert.ok(decision.files.includes('tests/core.test.mjs'));
}));

test('D16 non-code change takes explicit full route with reason', () => withFixture(f => {
  inject(f.args.headRoot, 'node', 'config-input');
  const decision = selectS12b({ ...f.args, bundle: f.bundle });
  assert.equal(decision.kind, 'full');
  assert.match(decision.reason, /D16 non-code full route: config\.json/);
  assert.equal(decision.files.length, 8);
}));

test('new test selected, source creation and removal refused', () => {
  withFixture(f => {
    inject(f.args.headRoot, 'node', 'new-test');
    assert.ok(selectS12b({ ...f.args, bundle: f.bundle }).files.includes('tests/new.test.mjs'));
  });
  withFixture(f => {
    writeFileSync(join(f.args.headRoot, 'src/new.mjs'), 'export const n = 1;\n');
    assert.match(selectS12b({ ...f.args, bundle: f.bundle }).reason, /new, removed or renamed source/);
  });
  withFixture(f => {
    inject(f.args.headRoot, 'node', 'source-removed');
    assert.equal(selectS12b({ ...f.args, bundle: f.bundle }).kind, 'refuse');
  });
});

test('stale identity, missing capability, truncation and shared write refuse', () => {
  withFixture(f => {
    assert.match(selectS12b({ ...f.args, baseCommit: 'other', bundle: f.bundle }).reason, /baseCommit/);
    const bad = structuredClone(f.bundle); bad.sidecar.completion.finishedFiles.pop();
    assert.equal(selectS12b({ ...f.args, bundle: bad }).kind, 'refuse');
    const badCap = structuredClone(f.bundle); badCap.sidecar.files['tests/core.test.mjs'].capabilities = [];
    assert.equal(selectS12b({ ...f.args, bundle: badCap }).kind, 'refuse');
    const badWrite = structuredClone(f.bundle); badWrite.sidecar.files['tests/core.test.mjs'].writes = ['src/core.mjs'];
    assert.equal(selectS12b({ ...f.args, bundle: badWrite }).kind, 'refuse');
  });
});

test('self-consistent critical omission and base mutation cannot reuse a prior decision', () => withFixture(f => {
  const bad = structuredClone(f.bundle);
  bad.core.criticalFiles = [];
  bad.core.identity.criticalFiles = digest([]).slice('sha256:'.length);
  bad.binding.core = digest(bad.core);
  assert.match(selectS12b({ ...f.args, bundle: bad }).reason, /verified engine labels/);
  assert.equal(selectS12b({ ...f.args, bundle: f.bundle }).kind, 'selected');
  writeFileSync(join(f.args.baseRoot, 'src/core.mjs'), 'export const changed = 1;\n');
  assert.match(selectS12b({ ...f.args, bundle: f.bundle }).reason, /baseline tree identity differs/);
}));

test('serialized validation claims cannot bypass live baseline checks', () => withFixture(f => {
  const bad = structuredClone(f.bundle);
  bad.binding.tree = 'bad';
  const decision = selectS12b({ ...f.args, bundle: bad, validated: true,
    requestSnapshot: { validated: true, inventory: bad.core.identity.files } });
  assert.equal(decision.kind, 'refuse');
  assert.match(decision.reason, /baseline tree identity differs/);
}));

test('head trace rejects newly unsupported channels and incomplete completion', () => withFixture(f => {
  inject(f.args.headRoot, 'node', 'source-text-pin');
  const decision = selectS12b({ ...f.args, bundle: f.bundle });
  const selectedTrace = structuredClone(f.sidecar);
  selectedTrace.files = Object.fromEntries(decision.files.map(file => [file, selectedTrace.files[file]]));
  selectedTrace.completion.expectedFiles = decision.files;
  selectedTrace.completion.finishedFiles = decision.files;
  assert.equal(assessHeadTrace({ ...f.args, decision, sidecar: selectedTrace }).kind, 'accepted');
  selectedTrace.files['tests/text.test.mjs'].unsupported.push('native-io');
  assert.equal(assessHeadTrace({ ...f.args, decision, sidecar: selectedTrace }).kind, 'refuse');
}));

test('negative probes, listings and unowned setup conservatively select owners', () => withFixture(f => {
  const sidecar = structuredClone(f.sidecar);
  sidecar.files['tests/independent.test.mjs'].probes.push('src/core.mjs');
  sidecar.files['tests/param.test.mjs'].directories.push('src');
  sidecar.global.imports.push('src/core.mjs');
  const bundle = makeBundle({ ...f.args, input: f.bundle.core.input, sidecar });
  inject(f.args.headRoot, 'node', 'ordinary-source');
  const decision = selectS12b({ ...f.args, bundle });
  assert.equal(decision.kind, 'selected');
  assert.equal(decision.files.length, 8);
}));

test('cross-runner selection unions files and refuses if one runner lacks proof', () => {
  const a = fixture(); const b = fixture();
  try {
    inject(a.args.headRoot, 'node', 'ordinary-source');
    inject(b.args.headRoot, 'node', 'source-text-pin');
    const union = selectAcrossRunners([{ ...a.args, bundle: a.bundle }, { ...b.args, bundle: b.bundle }]);
    assert.equal(union.kind, 'selected');
    assert.ok(union.files.includes('tests/core.test.mjs'));
    assert.ok(union.files.includes('tests/text.test.mjs'));
    const refused = selectAcrossRunners([{ ...a.args, bundle: a.bundle },
      { ...b.args, baseCommit: 'wrong', bundle: b.bundle }]);
    assert.equal(refused.kind, 'refuse');
  } finally {
    rmSync(a.root, { recursive: true, force: true });
    rmSync(b.root, { recursive: true, force: true });
  }
});

test('cached module linkage selects an owner without a filesystem read', () => withFixture(f => {
  const sidecar = structuredClone(f.sidecar);
  sidecar.files['tests/independent.test.mjs'].imports.push('src/setup.mjs');
  const bundle = makeBundle({ ...f.args, input: f.bundle.core.input, sidecar });
  inject(f.args.headRoot, 'node', 'shared-setup');
  assert.ok(selectS12b({ ...f.args, bundle }).files.includes('tests/independent.test.mjs'));
}));

test('an explicit read remains an observer even when the same source is imported', () => withFixture(f => {
  const sidecar = structuredClone(f.sidecar);
  sidecar.files['tests/independent.test.mjs'].imports.push('src/text.mjs');
  sidecar.files['tests/independent.test.mjs'].reads.push('src/text.mjs');
  const bundle = makeBundle({ ...f.args, input: f.bundle.core.input, sidecar });
  inject(f.args.headRoot, 'node', 'ordinary-source');
  assert.ok(selectS12b({ ...f.args, bundle }).files.includes('tests/independent.test.mjs'));
}));

test('missing sidecar, unsupported child/native activity, altered runner and symlink refuse', () => {
  withFixture(f => {
    assert.equal(selectS12b({ ...f.args, bundle: { ...f.bundle, sidecar: null } }).kind, 'refuse');
    const child = structuredClone(f.bundle);
    child.sidecar.files['tests/core.test.mjs'].unsupported.push('child-process');
    assert.equal(selectS12b({ ...f.args, bundle: child }).kind, 'refuse');
    const native = structuredClone(f.bundle);
    native.sidecar.global.unsupported.push('native-io');
    assert.equal(selectS12b({ ...f.args, bundle: native }).kind, 'refuse');
    assert.match(selectS12b({ ...f.args, runnerVersion: 'other', bundle: f.bundle }).reason, /runnerVersion/);
    symlinkSync(join(f.args.headRoot, 'src/core.mjs'), join(f.args.headRoot, 'src/link.mjs'));
    assert.match(selectS12b({ ...f.args, bundle: f.bundle }).reason, /refuses symlink/);
  });
});
