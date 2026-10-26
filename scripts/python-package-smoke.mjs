import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Build tools are prepared explicitly outside the smoke. Nothing here downloads
// packages or substitutes a different backend when the pinned one is missing.
export function pythonPackageSmoke({ root, scratch, checked, t }) {
  const manifest = JSON.parse(readFileSync(join(root, 'packages/cupel/package.json'), 'utf8'));
  const tools = join(root, '.scratch/package-tools');
  const python = process.env.CUPEL_PACKAGE_PYTHON ?? join(tools, 'runtime/bin/python');
  const wheelhouse = process.env.CUPEL_PACKAGE_WHEELS ?? join(tools, 'wheels');
  const missing = !existsSync(python) || !existsSync(wheelhouse);
  if (missing) {
    const message = 'BLOCKED: prepare the explicit package-tools Python and wheelhouse; setuptools 80.9.0 and pytest 9.1.1 are required';
    if (process.env.CUPEL_REQUIRE_PACKAGE_SMOKE === '1') assert.fail(message);
    t.skip(message);
    return;
  }
  const cleanEnv = { ...process.env, PYTHONPATH: '', PYTHONNOUSERSITE: '1', PIP_NO_INDEX: '1' };
  const options = { env: cleanEnv, cwd: scratch };
  const versions = checked(python, ['-c',
    'from importlib.metadata import version; import json; print(json.dumps({n:version(n) for n in ("setuptools", "pytest")}))'], options);
  assert.deepEqual(JSON.parse(versions.stdout), { setuptools: '80.9.0', pytest: '9.1.1' });
  for (const name of ['LICENSE', 'NOTICE']) {
    assert.deepEqual(readFileSync(join(root, 'packages/cupel-py', name)), readFileSync(join(root, name)), `${name} copy drifted`);
  }
  const artifacts = join(scratch, 'python-wheelhouse');
  mkdirSync(artifacts, { recursive: true });
  checked(python, ['-m', 'pip', '--isolated', '--disable-pip-version-check', 'wheel', '--no-index',
    '--no-build-isolation', '--no-deps', '--wheel-dir', artifacts, join(root, 'packages/cupel-py')], options);
  const wheels = readdirSync(artifacts).filter((name) => /^vibernt_cupel-.*\.whl$/.test(name));
  assert.equal(wheels.length, 1, 'expected exactly one built collector wheel');
  const wheel = join(artifacts, wheels[0]);
  const inspection = checked(python, ['-c', `
import email.parser,json,sys,tomllib,zipfile
with open(sys.argv[2], 'rb') as source:
    project=tomllib.load(source)['project']
with zipfile.ZipFile(sys.argv[1]) as z:
    names=z.namelist()
    legal={n.split('/')[-1]:z.read(n).decode() for n in names if '/licenses/' in n and n.split('/')[-1] in ('LICENSE','NOTICE')}
    metadata=z.read(next(n for n in names if n.endswith('.dist-info/METADATA'))).decode()
fields=email.parser.Parser().parsestr(metadata)
print(json.dumps({'legal':legal,'project':project,'metadata':dict(fields.items()),
    'classifiers':fields.get_all('Classifier',[])}))
`, wheel, join(root, 'packages/cupel-py/pyproject.toml')], options);
  const archive = JSON.parse(inspection.stdout);
  for (const name of ['LICENSE', 'NOTICE']) assert.equal(archive.legal[name], readFileSync(join(root, name), 'utf8'));
  assert.equal(archive.project.version, manifest.version);
  assert.equal(archive.project.license, manifest.license);
  assert.equal(archive.metadata.Version, manifest.version);
  assert.equal(archive.metadata['License-Expression'], manifest.license);
  assert.ok(archive.classifiers.includes('Private :: Do Not Upload'));
  assert.equal(archive.metadata['Requires-Python'], '>=3.12');
  assert.ok(wheels[0].startsWith(`vibernt_cupel-${manifest.version}-`),
    'wheel filename version differs from package metadata');
  const env = join(scratch, 'python-install');
  checked(python, ['-m', 'venv', env], options);
  const installedPython = join(env, 'bin/python');
  checked(installedPython, ['-m', 'pip', '--isolated', '--disable-pip-version-check', 'install',
    '--no-index', '--find-links', wheelhouse, wheel, 'pytest==9.1.1'], options);
  const imported = checked(installedPython, ['-c',
    'import json,vibernt_cupel; from importlib.metadata import metadata; m=metadata("vibernt-cupel"); print(json.dumps({"spec":vibernt_cupel.SPEC_VERSION,"file":vibernt_cupel.__file__,"version":m["Version"],"license":m["License-Expression"]}))'], options);
  const importedPackage = JSON.parse(imported.stdout);
  assert.equal(importedPackage.spec, 'cupel-spec/1');
  assert.equal(importedPackage.version, manifest.version);
  assert.equal(importedPackage.license, manifest.license);
  assert.ok(importedPackage.file.startsWith(env), 'collector import escaped the installed environment');
  const out = join(scratch, 'python-input.json');
  const fixture = join(root, 'spec/conformance/adapters/pytest');
  const collected = checked(installedPython, ['-m', 'vibernt_cupel', 'collect', '--root', fixture,
    '--runs', '1', '--out', out], options);
  const input = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(input.runtime.name, 'python');
  assert.equal(input.tests.length, 5);
  assert.ok(input.tests.every((row) => row.status === 'passed'), collected.stderr);
  writeFileSync(join(scratch, 'python-result.json'), JSON.stringify({ wheel,
    installedPython, runtime: input.runtime, tests: input.tests.length,
    version: importedPackage.version, license: importedPackage.license,
    checks: ['pinned-backend', 'wheel-license-and-private-metadata', 'clean-offline-install', 'installed-import', 'pytest-collection'],
  }, null, 2) + '\n');
}
