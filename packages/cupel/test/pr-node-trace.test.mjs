import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileTraceEvidence } from '../src/pr/profiles/node/trace-evidence.mjs';

const boundaries = [{ kind: 'bootstrap-ready' }, { kind: 'bootstrap-exit' }];

test('trace evidence retains repository-relative provenance and ignores private output', () => {
  const rows = [boundaries[0],
    { kind: 'module-linkage', channel: 'imports', file: 'src/auth.cjs' },
    { kind: 'readFileSync', channel: 'reads', file: 'src/auth.cjs', origin: 'application' },
    { kind: 'writeFileSync', channel: 'writes', file: '/tmp/cupel-out/coverage.json', origin: 'unknown' },
    boundaries[1]];
  const result = profileTraceEvidence(rows, { privateTmp: '/tmp/cupel-out' });
  assert.deepEqual(result.imports, ['src/auth.cjs']);
  assert.deepEqual(result.reads, ['src/auth.cjs']);
  assert.deepEqual(result.writes, []);
  assert.deepEqual(result.filesystemEvents, [{ channel: 'reads', path: 'src/auth.cjs',
    operation: 'readFileSync', origin: 'application' }]);
});

test('root directory enumeration is represented as a conservative root observer', () => {
  const result = profileTraceEvidence([boundaries[0],
    { kind: 'readdirSync', channel: 'directories', file: '', origin: 'application' },
    boundaries[1]]);
  assert.deepEqual(result.directories, ['.']);
  assert.equal(result.filesystemEvents[0].path, '.');
});

test('trace evidence refuses path escapes, missing provenance and repository writes', () => {
  for (const event of [
    { kind: 'statSync', channel: 'probes', file: '../secret', origin: 'application' },
    { kind: 'statSync', channel: 'probes', file: '/tmp/other', origin: 'application' },
    { kind: 'statSync', channel: 'probes', file: 'src/auth.cjs' },
    { kind: 'writeFileSync', channel: 'writes', file: 'src/auth.cjs', origin: 'application' },
  ]) assert.throws(() => profileTraceEvidence([boundaries[0], event, boundaries[1]],
    { privateTmp: '/tmp/cupel-out' }), /trace|provenance/);
});
