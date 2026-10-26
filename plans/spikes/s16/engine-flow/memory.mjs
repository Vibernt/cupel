// Fresh-process memory observation for the labeled 10k-unit synthetic report.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../../..');
const scratch = join(root, '.scratch/engine-flow');
const source = process.argv[2];
if (!['baseline', 'current'].includes(source)) throw new Error('usage: memory.mjs baseline|current');
const path = source === 'baseline' ? join(scratch, 'baseline/src/engine/index.mjs') :
  join(root, 'packages/cupel/src/engine/index.mjs');
const { run } = await import(pathToFileURL(path));
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const input = read(join(scratch, 'synthetic-10000.json'));
const schemas = Object.fromEntries(['input', 'config', 'report'].map(name =>
  [name, read(join(root, `spec/schemas/${name}.schema.json`))]));
if (global.gc) global.gc();
const beforeRss = process.memoryUsage().rss;
const result = run('report', { input }, {}, {}, schemas);
if (result.exit !== 0 || result.report.units.length !== 10000) throw new Error('unexpected report');
console.log(JSON.stringify({ source, node: process.version, inputRows: input.tests.length,
  beforeRssBytes: beforeRss, afterRssBytes: process.memoryUsage().rss,
  peakRssKiB: process.resourceUsage().maxRSS }));
