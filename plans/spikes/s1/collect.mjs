/**
 * S1 spike, step 1: run each node:test file alone, in its own process, with its own NODE_V8_COVERAGE directory.
 *
 *   node plans/spikes/s1/collect.mjs --assay <suite root> --out <dir> [--jobs 5] [--timeout 600]
 *        [--no-coverage] [--files tests/a.test.mjs,tests/b.test.mjs]
 *
 * For each tests/*.test.mjs it runs `/usr/bin/time -p -o <time> node --test --test-reporter=tap
 * --test-reporter-destination=<tap> <file>` in the suite root, a pool of --jobs at a time, and writes:
 *   <out>/cov/<name>/coverage-*.json   raw V8 coverage (the runner, the test process and any node children)
 *   <out>/tap/<name>.tap, <out>/log/<name>.log, <out>/time/<name>.txt
 *   <out>/runs.jsonl                   one line per file: wall ms, user/sys s, exit code, tap counts
 *   <out>/collect.json                 totals: wall time of the whole collection, jobs, node version
 * With --no-coverage nothing goes to cov/ and the files are suffixed `-nocov`, to measure coverage overhead.
 * Standard library only. Never writes inside the suite root (the tests themselves may).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, openSync, closeSync, existsSync, rmSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
    assay: { type: 'string' }, out: { type: 'string' }, jobs: { type: 'string', default: '5' },
    timeout: { type: 'string', default: '600' }, 'no-coverage': { type: 'boolean', default: false }, files: { type: 'string' }
} });
if (!values.assay || !values.out) { console.error('usage: collect.mjs --assay <dir> --out <dir> [--jobs N]'); process.exit(2); }
const root = resolve(values.assay), out = resolve(values.out), jobs = Number(values.jobs), cov = !values['no-coverage'];
const suffix = cov ? '' : '-nocov', timeoutMs = Number(values.timeout) * 1000;
const files = values.files ? values.files.split(',') :
    readdirSync(resolve(root, 'tests')).filter(f => f.endsWith('.test.mjs')).sort().map(f => `tests/${f}`);
for (const d of ['cov', 'tap', 'log', 'time']) mkdirSync(resolve(out, d), { recursive: true });
const runsFile = resolve(out, `runs${suffix}.jsonl`);
if (!values.files && existsSync(runsFile)) rmSync(runsFile);

const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}` };
delete env.NODE_V8_COVERAGE;

function tapCounts(text) {
    const pick = k => Number(text.match(new RegExp(`^# ${k} (\\d+)`, 'm'))?.[1] ?? NaN);
    return { tests: pick('tests'), pass: pick('pass'), fail: pick('fail'), skipped: pick('skipped'), todo: pick('todo'), cancelled: pick('cancelled') };
}

function runOne(file) {
    const name = basename(file, '.test.mjs') + suffix;
    const covDir = resolve(out, 'cov', name), tap = resolve(out, 'tap', `${name}.tap`), time = resolve(out, 'time', `${name}.txt`);
    rmSync(covDir, { recursive: true, force: true });
    if (cov) mkdirSync(covDir, { recursive: true });
    const log = openSync(resolve(out, 'log', `${name}.log`), 'w');
    const args = ['-p', '-o', time, process.execPath, '--test', '--test-reporter=tap', `--test-reporter-destination=${tap}`, file];
    const started = performance.now();
    return new Promise(done => {
        const child = spawn('/usr/bin/time', args, { cwd: root, env: cov ? { ...env, NODE_V8_COVERAGE: covDir } : env, stdio: ['ignore', log, log] });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
        child.on('close', code => {
            clearTimeout(timer); closeSync(log);
            const wallMs = Math.round(performance.now() - started);
            let user = NaN, sys = NaN;
            try { const t = readFileSync(time, 'utf8'); user = Number(t.match(/^user (\S+)/m)?.[1]); sys = Number(t.match(/^sys (\S+)/m)?.[1]); } catch { }
            let counts = {};
            try { counts = tapCounts(readFileSync(tap, 'utf8')); } catch { }
            const rec = { file, name, exit: code, timedOut, wallMs, user, sys, ...counts };
            appendFileSync(runsFile, JSON.stringify(rec) + '\n');
            done(rec);
        });
    });
}

const t0 = performance.now(), queue = [...files], results = [];
let doneCount = 0;
async function worker() {
    while (queue.length) {
        const rec = await runOne(queue.shift());
        results.push(rec); doneCount++;
        if (rec.exit !== 0 || rec.fail > 0 || doneCount % 25 === 0)
            console.log(`[${doneCount}/${files.length}] ${rec.file} exit=${rec.exit} fail=${rec.fail} ${rec.wallMs}ms`);
    }
}
await Promise.all(Array.from({ length: jobs }, worker));
const wallMs = Math.round(performance.now() - t0);
const sum = k => results.reduce((a, r) => a + (Number.isFinite(r[k]) ? r[k] : 0), 0);
const summary = { coverage: cov, jobs, files: files.length, wallMs, userS: +sum('user').toFixed(2), sysS: +sum('sys').toFixed(2),
    tests: sum('tests'), pass: sum('pass'), fail: sum('fail'), skipped: sum('skipped'), nonZeroExit: results.filter(r => r.exit !== 0).map(r => r.file),
    node: process.version, startedAt: new Date(Date.now() - wallMs).toISOString() };
if (!values.files) writeFileSync(resolve(out, `collect${suffix}.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
