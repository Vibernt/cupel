// Phase 7: code built into an artifact that another language's tests load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyBuiltInto } from '../src/cli/built-into.mjs';
import { mergeRunners, runnerParts } from '../src/cli/merge-runners.mjs';
import { validate } from '../src/engine/schema.mjs';

const schema = JSON.parse(readFileSync(new URL('../../../spec/schemas/input.schema.json', import.meta.url), 'utf8'));
const rust = {
  spec: 'cupel-spec/1', kind: 'input', runtime: { name: 'rust', version: '1.94.1' },
  sources: { 'crates/wasm/src/lib.rs': { coverable: '1-20' }, 'crates/wasm/src/host.rs': { coverable: '1-5' }, 'crates/core/src/lib.rs': { coverable: '1-9' } },
  tests: [{ id: 'crates/core/src/lib.rs::t', file: 'crates/core/src/lib.rs', name: 't', status: 'passed' }],
  coverage: { granularity: 'test', byTest: { 'crates/core/src/lib.rs::t': { 'crates/core/src/lib.rs': '1-9', 'crates/wasm/src/host.rs': '2' } } },
};
const node = {
  spec: 'cupel-spec/1', kind: 'input', runtime: { name: 'node', version: '26.7.0' },
  sources: { 'cloud/src/space.mjs': { coverable: '1-4' } },
  tests: [
    { id: 'cloud/test/a.test.mjs::a', file: 'cloud/test/a.test.mjs', name: 'a', status: 'passed', loads: ['cloud/src/prill.wasm'] },
    { id: 'cloud/test/a.test.mjs::b', file: 'cloud/test/a.test.mjs', name: 'b', status: 'passed', loads: ['cloud/src/prill.wasm'] },
  ],
  coverage: { granularity: 'test', byTest: { 'cloud/test/a.test.mjs::a': { 'cloud/src/space.mjs': '1-4' } } },
};
const cfg = { builtInto: { 'crates/wasm/**': 'cloud/src/prill.wasm' } };

test('uncovered sources built into a loaded artifact become unmeasured, in every runner part', () => {
  const merged = mergeRunners([{ name: 'cargo', input: rust }, { name: 'node', input: node }]);
  const out = applyBuiltInto(merged, cfg);
  assert.deepEqual(out.sources['crates/wasm/src/lib.rs'], { coverable: '', unmeasured: 'built into cloud/src/prill.wasm, which 2 tests load; lines inside WebAssembly are not measured' });
  // A source its own tests reach keeps its native coverage.
  assert.equal(out.sources['crates/wasm/src/host.rs'].coverable, '1-5');
  assert.equal(out.sources['crates/core/src/lib.rs'].unmeasured, undefined);
  assert.equal(runnerParts(out).find((p) => p.name === 'cargo').input.sources['crates/wasm/src/lib.rs'].coverable, '');
  assert.deepEqual(validate(schema, out), []);
});

test('without builtInto or loads nothing changes, and an unloaded artifact says so', () => {
  assert.equal(applyBuiltInto(rust, {}), rust);
  const out = applyBuiltInto(rust, cfg);
  assert.equal(out.sources['crates/wasm/src/lib.rs'].unmeasured, 'built into cloud/src/prill.wasm; no measured test loads it');
});

test('cross-runner faults: cargo-mutants diffs apply exactly to the original source', async () => {
  const { applyDiff } = await import('../src/cli/cross-runner.mjs');
  const fixture = new URL('../../../spec/conformance/adapters/cargo-workspace/', import.meta.url);
  const listing = JSON.parse(readFileSync(new URL('fixtures/cargo-mutants-ws/listing.json', import.meta.url), 'utf8'));
  let applied = 0;
  for (const m of listing.filter((x) => x.file !== 'core/src/wasm_only.rs')) {
    const original = readFileSync(new URL(m.file, fixture), 'utf8');
    const mutated = applyDiff(original, m.diff);
    assert.notEqual(mutated, original, m.name);
    assert.ok(mutated.includes('/* ~ changed by cargo-mutants ~ */'), m.name);
    assert.equal(mutated.split('\n').length - original.split('\n').length, m.diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length - m.diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length, m.name);
    applied++;
  }
  assert.ok(applied >= 15);
});
