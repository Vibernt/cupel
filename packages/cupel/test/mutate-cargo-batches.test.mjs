import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mutantId } from '../src/mutate-cargo/import.mjs';
import { partitionBatches, selectorDigest, stableSelectors } from '../src/mutate-cargo/batches.mjs';

function listed(file, line, column, tag) {
  return {
    file,
    genre: 'BinaryOperator',
    name: `${file}:${line}:${column}: replace ${tag}`,
    replacement: tag,
    span: { start: { line, column }, end: { line, column: column + 1 } },
  };
}

test('stable selectors cover the file inventory, not the selected run', () => {
  const listing = [
    listed('src/b.rs', 1, 1, 'b'),
    listed('src\\a.rs', 3, 2, 'late'),
    listed('src/a.rs', 2, 8, 'right'),
    listed('src/a.rs', 2, 3, 'left'),
    listed('src/outside.rs', 1, 1, 'outside'),
  ];
  const files = ['src/b.rs', 'src/a.rs'];
  const selectors = stableSelectors(listing, { files });
  const expected = [listing[3], listing[2], listing[1], listing[0]].map(mutantId);

  assert.deepEqual([...selectors], expected.map((id, index) => [id, index + 1]));
  assert.deepEqual([...stableSelectors([...listing].reverse(), { files: [...files].reverse() })], [...selectors]);
  assert.equal(selectors.has(mutantId(listing[4])), false, 'a mutant outside files is excluded');

  const chosenRun = [expected[1], expected[3]];
  assert.deepEqual(chosenRun.map((id) => [id, selectors.get(id)]), [[expected[1], 2], [expected[3], 4]],
    'choosing a run subset does not renumber its selectors');
});

test('selector digest is independent of Map order and changes with a selector', () => {
  const first = new Map([['fault-b', 2], ['fault-a', 1]]);
  const reordered = new Map([['fault-a', 1], ['fault-b', 2]]);
  const changed = new Map([['fault-a', 1], ['fault-b', 3]]);

  assert.match(selectorDigest(first), /^sha256:[0-9a-f]{64}$/);
  assert.equal(selectorDigest(first), selectorDigest(reordered));
  assert.notEqual(selectorDigest(first), selectorDigest(changed));
});

function fault(id, source, line, name) {
  return {
    id,
    source,
    line,
    genre: line % 2 ? 'BinaryOperator' : 'FnValue',
    ...(name ? { function: { name, span: { start: { line: 1, column: 1 }, end: { line: 100, column: 1 } } } } : {}),
  };
}

test('compilation batches are deterministic, single-source and bounded', () => {
  const faults = [
    ...Array.from({ length: 6 }, (_, i) => fault(`alpha-${i}`, 'src/a.rs', i + 1, 'alpha')),
    ...Array.from({ length: 4 }, (_, i) => fault(`beta-${i}`, 'src/a.rs', i + 7, 'beta')),
    fault('free-1', 'src/a.rs', 20),
    fault('free-2', 'src/a.rs', 21),
    ...Array.from({ length: 5 }, (_, i) => fault(`gamma-${i}`, 'src/b.rs', i + 1, 'gamma')),
  ];
  const options = { maxFaultsPerBatch: 4, maxPerFunction: 2 };
  const batches = partitionBatches(faults, options);
  const byId = new Map(faults.map((row) => [row.id, row]));

  assert.deepEqual(partitionBatches([...faults].reverse(), options), batches);
  assert.equal(new Set(batches.flatMap((batch) => batch.faults)).size, faults.length);
  for (const batch of batches) {
    assert.match(batch.key, /^src\/[ab]\.rs#[0-9a-f]{64}$/);
    assert.ok(batch.faults.length <= options.maxFaultsPerBatch);
    assert.equal(new Set(batch.faults.map((id) => byId.get(id).source)).size, 1, 'a batch never mixes source files');
    const perFunction = new Map();
    for (const id of batch.faults) {
      const name = byId.get(id).function?.name;
      if (name) perFunction.set(name, (perFunction.get(name) ?? 0) + 1);
    }
    assert.ok([...perFunction.values()].every((count) => count <= options.maxPerFunction));
  }

  const onlyA = batches.filter((batch) => batch.faults.every((id) => byId.get(id).source === 'src/a.rs'));
  assert.deepEqual(partitionBatches(faults.filter((row) => row.source === 'src/a.rs'), options), onlyA,
    'removing other source files leaves this source unchanged');
});

test('each emitted batch is stable when every other batch is removed', () => {
  const faults = Array.from({ length: 13 }, (_, i) => fault(`fault-${i}`, 'src/lib.rs', i + 1, i < 9 ? 'dense' : 'other'));
  const options = { maxFaultsPerBatch: 5, maxPerFunction: 3 };
  const batches = partitionBatches(faults, options);
  const byId = new Map(faults.map((row) => [row.id, row]));

  assert.ok(batches.length > 1);
  for (const batch of batches) {
    const isolated = batch.faults.map((id) => byId.get(id));
    assert.deepEqual(partitionBatches(isolated, options), [batch],
      'a CI slice may select a complete batch without changing its key or membership');
  }
});
