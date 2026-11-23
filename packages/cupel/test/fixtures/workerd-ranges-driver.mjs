// Runs Cupel's engine over its conformance cases twice in one process and prints, per engine
// source, the covered lines from (a) V8 precise block coverage and (b) never-pausing breakpoints
// set after module load, rebuilt with workerd-ranges.mjs. Used by test/workerd-ranges.test.mjs.
import { Session } from 'node:inspector/promises';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyse, coveredLines } from '../../src/collect/node/lines.mjs';
import { positiveIntervals, unionIntervals } from '../../src/collect/node/intervals.mjs';
import { functionRanges, paintHits, topLevelIntervals } from '../../src/collect/node/workerd-ranges.mjs';

const mode = process.argv[2];
const limit = Number(process.argv[3] ?? Infinity);
const engineDir = fileURLToPath(new URL('../../src/engine/', import.meta.url));
const casesDir = fileURLToPath(new URL('../../../../spec/conformance/cases/', import.meta.url));
const schemas = Object.fromEntries(['input', 'config', 'report'].map((n) => [n,
  JSON.parse(readFileSync(new URL(`../../../../spec/schemas/${n}.schema.json`, import.meta.url), 'utf8'))]));
const session = new Session();
session.connect();
const inEngine = (url) => url.startsWith(pathToFileURL(engineDir).href);

if (mode === 'precise') {
  await session.post('Profiler.enable');
  await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
}
const { run } = await import('../../src/engine/index.mjs');
const scripts = new Map();
let hits = null;
if (mode === 'breakpoints') {
  session.on('Debugger.scriptParsed', ({ params }) => { if (inEngine(params.url)) scripts.set(params.scriptId, params.url); });
  await session.post('Debugger.enable');
  globalThis.__cupelHits = new Set();
  hits = new Map();
  for (const [scriptId, url] of scripts) {
    const src = readFileSync(fileURLToPath(url), 'utf8');
    const lines = src.split('\n').length;
    const { locations } = await session.post('Debugger.getPossibleBreakpoints', { start: { scriptId, lineNumber: 0, columnNumber: 0 }, end: { scriptId, lineNumber: lines, columnNumber: 0 } });
    const base = hits.size;
    hits.set(url, { locations, base });
    for (const [k, l] of locations.entries()) {
      await session.post('Debugger.setBreakpoint', { location: { scriptId, lineNumber: l.lineNumber, columnNumber: l.columnNumber }, condition: `globalThis.__cupelHits.add(${JSON.stringify(`${url} ${k}`)}), false` });
    }
  }
}

for (const dir of readdirSync(casesDir).sort().slice(0, limit)) {
  const c = JSON.parse(readFileSync(`${casesDir}${dir}/case.json`, 'utf8'));
  const read = (f) => existsSync(`${casesDir}${dir}/${f}`) ? JSON.parse(readFileSync(`${casesDir}${dir}/${f}`, 'utf8')) : undefined;
  const inputs = c.command === 'guard' || existsSync(`${casesDir}${dir}/base.json`) ? { base: read('base.json'), head: read('head.json') } : { input: read('input.json') };
  try { run(c.command, inputs, read('config.json') ?? {}, c.args ?? {}, schemas); } catch { /* error paths count too */ }
}

const out = {};
if (mode === 'precise') {
  const { result } = await session.post('Profiler.takePreciseCoverage');
  for (const s of result) {
    if (!inEngine(s.url)) continue;
    const src = readFileSync(fileURLToPath(s.url), 'utf8');
    out[s.url.slice(pathToFileURL(engineDir).href.length)] = coveredLines(analyse(src), positiveIntervals(s.functions));
  }
} else {
  for (const [url, { locations }] of hits) {
    const src = readFileSync(fileURLToPath(url), 'utf8');
    const ranges = functionRanges(src);
    const hit = new Set();
    for (const [k] of locations.entries()) if (globalThis.__cupelHits.has(`${url} ${k}`)) hit.add(k);
    const iv = unionIntervals(topLevelIntervals(src, ranges), paintHits(src, ranges, locations.map((l) => ({ line: l.lineNumber, column: l.columnNumber, type: l.type })), hit));
    out[url.slice(pathToFileURL(engineDir).href.length)] = coveredLines(analyse(src), iv);
    if (process.env.DEBUG_FILE && url.endsWith(process.env.DEBUG_FILE)) {
      const lo = Number(process.env.DEBUG_FROM), hi = Number(process.env.DEBUG_TO);
      for (const [k, l] of locations.entries()) if (l.lineNumber + 1 >= lo && l.lineNumber + 1 <= hi) process.stderr.write(`loc ${k} ${l.lineNumber + 1}:${l.columnNumber}:${l.type ?? ""} ${hit.has(k) ? "HIT" : "-"}\n`);
      for (const r of ranges) if (r.end > (src.split('\n').slice(0, lo - 1).join('\n').length) && r.header < src.split('\n').slice(0, hi).join('\n').length) process.stderr.write(`range ${JSON.stringify(src.slice(r.header, Math.min(r.end, r.header + 60)))} .. end line ${src.slice(0, r.end).split('\n').length}\n`);
    }
  }
}
process.stdout.write(JSON.stringify(out));
