import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFiles } from '../s12/fixtures.mjs';
import { safeFileInventory } from './evidence-base.mjs';
import { digest } from './evidence.mjs';
import { validateProfileEvidence } from './evidence-profile.mjs';
import { loadLockedDependencies, observedDependencyEvidence } from './node-profile/dependencies.mjs';
import { readOnlyInventory } from './node-profile/inputs.mjs';

function fixture(dependency = false) {
  const root = mkdtempSync('/tmp/cupel-s12b-profile-evidence-');
  writeFiles(root, { 'src/value.ts': 'export const value: number = 1;\n',
    'tests/value.test.mjs': "import '../src/value.ts';\n",
    'package.json': '{"name":"profile-evidence","private":true}\n',
    ...(dependency ? {
      'package-lock.json': JSON.stringify({ name: 'profile-evidence', lockfileVersion: 3,
        packages: { '': { name: 'profile-evidence', version: '1.0.0' },
          'node_modules/local-pkg': { version: '1.0.0' } } }) + '\n',
      'node_modules/local-pkg/package.json': '{"name":"local-pkg","version":"1.0.0","main":"index.js"}\n',
      'node_modules/local-pkg/index.js': 'module.exports = 1;\n',
    } : {}) });
  const inventory = safeFileInventory(root);
  const manifest = readOnlyInventory(root, { nodeModules: 'skip' });
  const lock = loadLockedDependencies(root);
  const paths = dependency ? ['node_modules/local-pkg/index.js', 'node_modules/local-pkg/package.json'] : [];
  const observed = observedDependencyEvidence(root, paths, lock);
  const imports = ['src/value.ts', ...(dependency ? ['node_modules/local-pkg/index.js'] : [])];
  const sidecar = { execution: { inputManifestHash: digest(manifest), dependencyLockHash: lock.lockHash },
    dependencies: { lockHash: lock.lockHash, files: observed },
    nativeTypeScript: { files: { 'src/value.ts': manifest['src/value.ts'] } },
    files: { 'tests/value.test.mjs': { imports, reads: [], probes: [],
      capabilities: ['native-typescript', ...(dependency ? ['locked-pure-js'] : [])] } },
    global: { imports: [], reads: [], probes: [] } };
  return { root, inventory, sidecar };
}

test('native TypeScript raw bytes and observed locked package metadata validate', () => {
  for (const dependency of [false, true]) {
    const f = fixture(dependency);
    try {
      assert.equal(validateProfileEvidence(f).error, null);
      const reordered = Object.fromEntries(Object.entries(f.inventory).reverse());
      assert.equal(validateProfileEvidence({ ...f, inventory: reordered }).error, null);
    }
    finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('altered TS, lock, dependency bytes or missing package metadata refuse', () => {
  const f = fixture(true);
  try {
    const check = sidecar => validateProfileEvidence({ ...f, sidecar }).error;
    const badTs = structuredClone(f.sidecar);
    badTs.nativeTypeScript.files['src/value.ts'] = 'bad';
    assert.match(check(badTs), /raw-source identity/);
    const missingTs = structuredClone(f.sidecar);
    missingTs.nativeTypeScript.files = {};
    assert.match(check(missingTs), /lacks raw-source/);
    const badLock = structuredClone(f.sidecar);
    badLock.dependencies.lockHash = 'bad';
    assert.match(check(badLock), /lock identity/);
    const noMetadata = structuredClone(f.sidecar);
    delete noMetadata.dependencies.files['node_modules/local-pkg/package.json'];
    assert.match(check(noMetadata), /file hashes differ/);
    const noCapability = structuredClone(f.sidecar);
    noCapability.files['tests/value.test.mjs'].capabilities = ['native-typescript'];
    assert.match(check(noCapability), /locked pure JavaScript capability missing/);
    writeFileSync(join(f.root, 'node_modules/local-pkg/index.js'), 'module.exports = 2;\n');
    assert.match(check(f.sidecar), /file hashes differ/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
