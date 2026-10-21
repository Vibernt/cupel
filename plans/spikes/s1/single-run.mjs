/**
 * S1 spike, step 6 (collector design check): get per-file coverage from ONE ordinary `node --test` run, instead of
 * one run per file, by tagging each process.
 *
 *   node plans/spikes/s1/single-run.mjs --assay <suite root> --out <dir> [--concurrency N]
 *   node plans/spikes/s1/compare.mjs <out>/lines-cov <out>/lines-single
 *
 * It writes a preload (<out>/single/tag-preload.mjs) that every node process loads through NODE_OPTIONS=--import;
 * the preload records { pid, ppid, argv } next to that process's V8 coverage file. node --test already runs each
 * test file in its own child process, so each coverage file is attributed to the test file in its own argv, or in
 * its nearest ancestor's (for processes the tests spawn). Writes <out>/lines-single/<name>.json (scope src-public)
 * and <out>/single.json (wall time, CPU from /usr/bin/time, unattributed coverage files).
 * Standard library only.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { linesFromCoverage, toPlain } from './lines.mjs';

const { values } = parseArgs({ options: { assay: { type: 'string' }, out: { type: 'string' }, concurrency: { type: 'string' } } });
if (!values.assay || !values.out) { console.error('usage: single-run.mjs --assay <dir> --out <dir> [--concurrency N]'); process.exit(2); }
const root = resolve(values.assay), out = resolve(values.out), dir = resolve(out, 'single'), cov = resolve(dir, 'cov');
rmSync(dir, { recursive: true, force: true }); mkdirSync(cov, { recursive: true });
const preload = resolve(dir, 'tag-preload.mjs');
writeFileSync(preload, `import { writeFileSync } from 'node:fs';
const d = process.env.NODE_V8_COVERAGE;
if (d) try { writeFileSync(d + '/tag-' + process.pid + '.json', JSON.stringify({ pid: process.pid, ppid: process.ppid, argv: process.argv })); } catch { }
`);
const files = readdirSync(resolve(root, 'tests')).filter(f => f.endsWith('.test.mjs')).sort().map(f => `tests/${f}`);
const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}`, NODE_V8_COVERAGE: cov,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(preload).href}`.trim() };
const conc = values.concurrency ? [`--test-concurrency=${values.concurrency}`] : [];
const timeFile = resolve(dir, 'time.txt'), t0 = performance.now();
const run = spawnSync('/usr/bin/time', ['-p', '-o', timeFile, process.execPath, '--test', '--test-reporter=tap',
    `--test-reporter-destination=${resolve(dir, 'run.tap')}`, ...conc, ...files], { cwd: root, env, stdio: 'ignore' });
const wallMs = Math.round(performance.now() - t0);
const time = readFileSync(timeFile, 'utf8');

// Attribute coverage files to test files through the pid tags.
const tags = new Map(), suite = new Set(files.map(f => resolve(root, f)));
for (const f of readdirSync(cov)) if (f.startsWith('tag-')) { const t = JSON.parse(readFileSync(resolve(cov, f), 'utf8')); tags.set(t.pid, t); }
const testOf = pid => {
    for (let p = pid, hops = 0; p && hops < 20; hops++) {
        const t = tags.get(p); if (!t) return null;
        const named = t.argv.filter(a => suite.has(resolve(root, a)));
        if (named.length === 1) return basename(named[0], '.test.mjs'); // the per-file child (the runner names them all)
        p = t.ppid;
    }
    return null;
};
const groups = new Map(); let unattributed = 0, unattributedWithLines = 0;
for (const f of readdirSync(cov).filter(f => f.startsWith('coverage-')).sort()) {
    const name = testOf(Number(f.split('-')[1]));
    if (!name) {
        unattributed++;
        if (linesFromCoverage([JSON.parse(readFileSync(resolve(cov, f), 'utf8'))], root).lines.size) unattributedWithLines++;
        continue;
    }
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(resolve(cov, f));
}
rmSync(resolve(out, 'lines-single'), { recursive: true, force: true });
mkdirSync(resolve(out, 'lines-single'), { recursive: true });
for (const [name, paths] of groups) {
    const { lines } = linesFromCoverage(paths.map(p => JSON.parse(readFileSync(p, 'utf8'))), root);
    writeFileSync(resolve(out, 'lines-single', `${name}.json`), JSON.stringify(toPlain(lines)));
}
const tap = readFileSync(resolve(dir, 'run.tap'), 'utf8');
const summary = { exit: run.status, wallMs, user: Number(time.match(/^user (\S+)/m)?.[1]), sys: Number(time.match(/^sys (\S+)/m)?.[1]),
    tests: Number(tap.match(/^# tests (\d+)/m)?.[1]), fail: Number(tap.match(/^# fail (\d+)/m)?.[1]),
    testFiles: files.length, attributedTestFiles: groups.size, unattributedCoverageFiles: unattributed, unattributedWithSourceLines: unattributedWithLines, concurrency: values.concurrency ?? 'node default' };
writeFileSync(resolve(out, 'single.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
