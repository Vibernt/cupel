import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { rawDirectory } from './artifacts.mjs';
import { diagnoseRun } from './diagnostic.mjs';
import { measureRun } from './measure.mjs';
import { prepareRun } from './prepare.mjs';

const [phase, raw] = process.argv.slice(2);
if (!['prepare', 'diagnostic', 'timing'].includes(phase) || !raw || !isAbsolute(raw))
  throw new Error('usage: node run.mjs prepare|diagnostic|timing /absolute/.scratch/s16/unique-run');
const runDir = rawDirectory(raw);
if (phase === 'prepare' && existsSync(runDir))
  throw new Error('S16 prepare requires a new unique raw directory');
if (phase === 'diagnostic' && existsSync(join(runDir, 'diagnostic-summary.json')))
  throw new Error('S16 diagnostics already exist; use the saved raw evidence');
if (phase === 'timing' && existsSync(join(runDir, 'timing-summary.json')))
  throw new Error('S16 warm timing evidence already exists');

const result = phase === 'prepare' ? prepareRun({ runDir, nodePath: process.execPath }) :
  phase === 'diagnostic' ? diagnoseRun({ runDir, nodePath: process.execPath }) :
    measureRun({ runDir, nodePath: process.execPath });
process.stdout.write(`${JSON.stringify({ phase, runDir,
  ...(phase === 'prepare' ? { cases: result.cases, baselineTests: result.baselineTests } :
    phase === 'diagnostic' ? { inventory: result.inventory,
      methods: Object.keys(result.results) } :
      { comparisons: Object.fromEntries(Object.entries(result.comparisons).map(([name, row]) =>
        [name, row.gate])) }) })}\n`);
