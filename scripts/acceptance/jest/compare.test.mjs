import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ordinaryRows, assertCollectionParity } from './compare.mjs';

test('ordinary IDs retain full suite ancestry, duplicate occurrences and pending statuses', () => {
  const ordinary = { testResults:[{ name:'/project/tests/math.test.js', assertionResults:[
    { ancestorTitles:['suite'], title:'same', status:'passed' },
    { ancestorTitles:['suite'], title:'same', status:'pending' },
    { ancestorTitles:[], title:'todo', status:'todo' },
  ] }] };
  const rows = ordinaryRows('/project', ordinary);
  assert.deepEqual(rows,[
    { id:'tests/math.test.js::suite > same', status:'passed' },
    { id:'tests/math.test.js::suite > same #2', status:'skipped' },
    { id:'tests/math.test.js::todo', status:'skipped' },
  ]);
  const input = {tests:rows.map(row => ({ ...row, runner:'jest', runStatuses:[row.status,row.status] }))};
  assert.deepEqual(assertCollectionParity('/project', ordinary, input), rows);
  input.tests.pop();
  assert.throws(() => assertCollectionParity('/project', ordinary, input), /deep-equal/);
});
