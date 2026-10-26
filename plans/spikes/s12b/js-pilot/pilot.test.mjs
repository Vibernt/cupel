import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const repo = fileURLToPath(new URL('../../../..', import.meta.url));
const summaryFile = join(repo, '.scratch/s12b/pilot-summary.json');

test('actual JS runners record conservative dependency evidence', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url))],
    {cwd:repo,encoding:'utf8',timeout:60000});
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(readFileSync(summaryFile,'utf8'));
  assert.deepEqual(summary.map(row=>row.runner), ['node','vitest','jest']);
  for (const row of summary) {
    assert.equal(row.ordinaryExit, 0, `${row.runner} ordinary full oracle`);
    assert.deepEqual(row.completion.errors, []);
    assert.deepEqual(row.completion.finishedFiles, row.completion.expectedFiles);
    const ext = row.runner === 'node' ? 'mjs' : row.runner === 'vitest' ? 'ts' : 'cjs';
    const entry = name => row.files[`tests/${name}.test.${ext}`];
    assert.ok(entry('text').reads.includes(`src/text.${ext}`), `${row.runner} source pin`);
    for (const name of ['cache-a','cache-b'])
      assert.ok(entry(name).reads.includes('config.json'), `${row.runner} ${name} cached module read`);
    assert.ok(entry('io').reads.includes(`src/text.${ext}`), `${row.runner} captured alias and stream`);
    assert.ok(entry('io').reads.includes('config.json'), `${row.runner} promises read`);
    assert.ok(entry('io').probes.includes(`src/absent.${ext}`), `${row.runner} negative metadata probe`);
    const sidecar = JSON.parse(readFileSync(join(row.root,'sidecar.json'),'utf8'));
    assert.ok(sidecar.files[`tests/io.test.${ext}`].directories.includes('src'), `${row.runner} directory probe`);
    assert.equal(sidecar.version, 'cupel-pr-dependencies/1');
    assert.equal(sidecar.execution.isolation, 'experimental-fresh-process-per-file');
    assert.ok(sidecar.files[`tests/io.test.${ext}`].unsupported.some(value=>value.startsWith('unproven:')));
  }
});
