import assert from 'node:assert/strict';
import { relative, sep } from 'node:path';

/** Independent ordinary-Jest row identity, including duplicate occurrence suffixes. */
export function ordinaryRows(root, result) {
  const rows = [];
  for (const suite of result.testResults) {
    const file = relative(root, suite.name).split(sep).join('/');
    const counts = new Map();
    for (const test of suite.assertionResults) {
      const name = [...test.ancestorTitles, test.title].join(' > ');
      const occurrence = (counts.get(name) ?? 0) + 1;
      counts.set(name, occurrence);
      rows.push({ id:`${file}::${name}${occurrence > 1 ? ` #${occurrence}` : ''}`,
        status:['pending','todo'].includes(test.status) ? 'skipped' : test.status });
    }
  }
  return rows.sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function assertCollectionParity(root, ordinary, input, runs = 2) {
  const expected = ordinaryRows(root, ordinary);
  assert.deepEqual(input.tests.map(({id,status}) => ({id,status})).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), expected);
  for (const test of input.tests) {
    assert.equal(test.runner, 'jest');
    assert.deepEqual(test.runStatuses, Array(runs).fill(test.status));
  }
  return expected;
}
