import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createPilotFixture } from './fixture.mjs';
import { captureJsDependencies } from './capture.mjs';
import { linkVitestModules } from '../../../../packages/cupel/test/vitest-modules.mjs';

const repo = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const scratch = join(repo, '.scratch/s12b');
const modules = {
  vitest: '/Users/vid/codecrystal/hub-ts/node_modules',
  jest: join(repo, '.scratch/jest-runtime/node_modules'),
};
const versions = { node:process.versions.node, vitest:'4.1.11', jest:'30.2.0' };
const summaries = [];
for (const runner of ['node','vitest','jest']) {
  const start = performance.now();
  const root = mkdtempSync(join(scratch, `${runner}-fixture-`));
  const {files} = createPilotFixture(root, runner);
  if (runner === 'vitest') linkVitestModules(root, modules.vitest);
  if (runner === 'jest') symlinkSync(modules.jest, join(root,'node_modules'), 'dir');
  const setupMs = Math.round(performance.now() - start);
  const out = join(scratch, 'artifacts-' + root.split('/').at(-1));
  const allTests = Object.keys(files).filter(path => path.includes('.test.')).sort();
  const result = captureJsDependencies({runner,root,files:allTests,out,version:versions[runner]});
  const ordinaryArgs = runner === 'node' ? ['--test', ...allTests] : runner === 'vitest' ?
    [join(root,'node_modules/vitest/vitest.mjs'),'run'] :
    [join(root,'node_modules/jest/bin/jest.js'),'--runInBand','--no-cache'];
  const ordinaryStart = performance.now();
  const ordinary = spawnSync(process.execPath, ordinaryArgs, {cwd:root,env:{PATH:process.env.PATH,CI:'1',NO_COLOR:'1',TZ:'UTC',LANG:'C'},encoding:'utf8',timeout:30000});
  const ordinaryMs = Math.round(performance.now()-ordinaryStart);
  writeFileSync(join(out,'ordinary-full.out'), `${ordinary.stdout ?? ''}\n${ordinary.stderr ?? ''}`);
  writeFileSync(join(root,'sidecar.json'), JSON.stringify(result.sidecar,null,2));
  summaries.push({runner,root,setupMs,ordinaryMs,ordinaryExit:ordinary.status,
    timings:result.timings,completion:result.sidecar.completion,
    files:Object.fromEntries(Object.entries(result.sidecar.files).map(([file,entry]) => [file,{
      imports:entry.imports.filter(path=>path.startsWith('src/')),
      reads:entry.reads.filter(path=>path.startsWith('src/')||path==='config.json'),
      probes:entry.probes.filter(path=>path.startsWith('src/')),
      directories:entry.directories.filter(path=>path.startsWith('src/')),
      unsupported:entry.unsupported,
    }]))});
}
writeFileSync(join(scratch,'pilot-summary.json'), JSON.stringify(summaries,null,2));
console.log(JSON.stringify(summaries));
