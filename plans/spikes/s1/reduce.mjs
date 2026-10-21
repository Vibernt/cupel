/**
 * S1 spike, step 2: reduce raw V8 coverage directories to per-run line sets (rule in lines.mjs).
 *
 *   node plans/spikes/s1/reduce.mjs --assay <suite root> --out <dir> [--dir cov] [--scope src-public|repo]
 *
 * Reads every <out>/<dir>/<name>/coverage-*.json and writes <out>/lines-<dir>/<name>.json ({ path: [lines] })
 * (<out>/lines-<dir>-repo/ with --scope repo) and <out>/reduce-<dir>[-repo].json (per run: raw bytes, coverage files, matched script entries; totals and time taken).
 * Standard library only.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { linesFromCoverage, toPlain } from './lines.mjs';

const { values } = parseArgs({ options: { assay: { type: 'string' }, out: { type: 'string' }, dir: { type: 'string', default: 'cov' }, scope: { type: 'string', default: 'src-public' } } });
if (!values.assay || !values.out) { console.error('usage: reduce.mjs --assay <dir> --out <dir> [--dir cov]'); process.exit(2); }
const root = resolve(values.assay), out = resolve(values.out), src = resolve(out, values.dir), tag = values.dir + (values.scope === 'repo' ? '-repo' : ''), dst = resolve(out, `lines-${tag}`);
mkdirSync(dst, { recursive: true });
const t0 = performance.now(), runs = {};
let rawBytes = 0, rawFiles = 0;
for (const name of readdirSync(src).sort()) {
    const dir = resolve(src, name), docs = [];
    let bytes = 0, n = 0;
    for (const f of readdirSync(dir)) {
        if (!f.startsWith('coverage-') || !f.endsWith('.json')) continue;
        const p = resolve(dir, f); bytes += statSync(p).size; n++;
        try { docs.push(JSON.parse(readFileSync(p, 'utf8'))); } catch { }
    }
    const { lines, scripts } = linesFromCoverage(docs, root, values.scope);
    const plain = toPlain(lines);
    writeFileSync(resolve(dst, `${name}.json`), JSON.stringify(plain));
    runs[name] = { rawBytes: bytes, coverageFiles: n, scripts, sourceFiles: Object.keys(plain).length,
        lines: Object.values(plain).reduce((a, l) => a + l.length, 0) };
    rawBytes += bytes; rawFiles += n;
}
const summary = { dir: values.dir, scope: values.scope, runs: Object.keys(runs).length, rawBytes, rawFiles, reduceMs: Math.round(performance.now() - t0), perRun: runs };
writeFileSync(resolve(out, `reduce-${tag}.json`), JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ ...summary, perRun: undefined }));
