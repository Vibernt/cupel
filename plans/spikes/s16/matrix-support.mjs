import { strict as assert } from 'node:assert';
import { exactRows, assertSameRows } from './oracle.mjs';

export function outcome(rows) {
  const checked = exactRows(rows, 'full oracle');
  return checked.some(row => row.status === 'failed') ? 'fail' : 'pass';
}

export function compareDecision(name, expected, old, candidate) {
  assert.equal(old.kind, expected.expectedDecision, `${name}: old decision`);
  assert.equal(candidate.kind, expected.decision, `${name}: S16 decision`);
  assert.deepEqual(candidate.files, old.files, `${name}: S16 selected files differ from old`);
  assert.deepEqual(candidate.files, expected.selectedFiles, `${name}: files differ from saved S12b`);
  return candidate.kind;
}

export function compareSelected(name, fullRows, oldRows, candidateRows, files) {
  const full = exactRows(fullRows, `${name} full`);
  const wanted = full.filter(row => files.includes(row.file));
  assert.ok(wanted.length, `${name}: empty selected reference`);
  assertSameRows(oldRows, wanted, `${name}: old versus full`);
  assertSameRows(candidateRows, wanted, `${name}: S16 versus full`);
  assert.ok(full.filter(row => row.status === 'failed')
    .every(row => files.includes(row.file)), `${name}: selected misses a full fault`);
  return { fullRows: full.length, selectedRows: wanted.length,
    fullFailures: full.filter(row => row.status === 'failed').length };
}

export function summarize(rows) {
  const cases = rows.filter(row => row.case);
  assert.equal(cases.length, 15, 'S16 matrix must cover the original 15 cases');
  const counts = { cases: cases.length,
    fullFaults: cases.filter(row => row.oracle === 'fail').length,
    selected: cases.filter(row => row.decision === 'selected').length,
    full: cases.filter(row => row.decision === 'full').length,
    refusals: cases.filter(row => row.decision === 'refuse').length,
    strictSubsets: cases.filter(row => row.strictSubset).length,
    changedStrictSubsets: cases.filter(row => row.strictSubset && row.case !== 'clean').length,
    changedSourceStrictSubsets: cases.filter(row => row.strictSubset &&
      ['ordinary-source', 'new-branch', 'shared-setup', 'line-shift', 'source-text-pin']
        .includes(row.case)).length };
  assert.deepEqual(counts, { cases: 15, fullFaults: 10, selected: 8,
    full: 1, refusals: 6, strictSubsets: 8, changedStrictSubsets: 7,
    changedSourceStrictSubsets: 5 });
  const pin = cases.find(row => row.case === 'source-text-pin');
  assert.equal(pin.selectedFiles.length, 4);
  assert.equal(pin.fullFiles.length, 8);
  assert.equal(pin.selected, 'fail');
  assert.ok(cases.filter(row => row.decision === 'selected' && row.oracle === 'fail')
    .every(row => row.selected === 'fail'), 'a selected fault was not caught');
  return counts;
}
