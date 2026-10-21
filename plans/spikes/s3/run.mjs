/**
 * Spike S3 runner: mutation testing of chosen modules of a node:test suite, with per-file and per-test kill
 * attribution. Node 22+ ESM, standard library only. Never writes to the suite's files: each mutant is served in
 * place of its module by a module hook (hook.mjs), so mutants can run in parallel.
 *
 * Usage (from anywhere; paths are absolute or relative to the cwd):
 *   node plans/spikes/s3/run.mjs <phase> --repo <suite root> --out <out dir> --config <config.json> [options]
 *
 * Phases, in order (each reads what the earlier ones wrote to --out):
 *   select     run every test file alone with NODE_V8_COVERAGE; keep the block coverage of the target modules
 *              (coverage.json) and each file's static import closure (imports.json)
 *   baseline   run every test file that covers a target, unmutated, with the hook and the reporter (baseline.json)
 *   mutants    generate, validate, filter and sample the mutants; select the test files for each (mutants.json)
 *   run        run each mutant's selected test files, one process per file (results.jsonl; resumable)
 *   recheck    run again, with a longer limit (recheckTimeoutFactor), the mutants whose run timed out (recheck.jsonl)
 *   report     aggregate into summary.json and print the tables
 *   all        the six in order
 *
 * Options: --jobs <n> (parallel processes, default 6), --seed <n> (default from config), --only <module name>,
 *          --stop-after-files <n> (stop a mutant once n files killed it; 0 = run every selected file; default 2),
 *          --test-files a,b (select: only these test files, for a quick trial).
 *
 * Config: { "seed": 20261021, "capPerModule": 150, "minutesPerModule": 25, "timeoutFactor": 3, "timeoutFloorMs": 2000,
 *           "recheckTimeoutFactor": 10,
 *           "modules": { "permissions": ["src/domain/permissions.mjs"], ... }, "tests": "tests" }
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import { generateMutants, applyMutant, sample, validate } from './mutate.mjs';
import { tokenize } from './lexer.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const phase = args[0];
const opt = (name, fallback) => {
    const k = args.indexOf(`--${name}`);
    return k >= 0 ? args[k + 1] : fallback;
};
const REPO = resolve(opt('repo', '.'));
const OUT = resolve(opt('out', '.scratch/out-s3'));
const CONFIG = JSON.parse(readFileSync(resolve(opt('config', join(HERE, 'config.json'))), 'utf8'));
const JOBS = Number(opt('jobs', 6));
const SEED = Number(opt('seed', CONFIG.seed));
const STOP_AFTER = Number(opt('stop-after-files', 2));
const ONLY = opt('only', null);
const TESTS_DIR = CONFIG.tests || 'tests';
const NODE = process.execPath;
mkdirSync(OUT, { recursive: true });

const targets = Object.entries(CONFIG.modules).flatMap(([module, files]) => files.map(file => ({ module, file, url: pathToFileURL(join(REPO, file)).href })));
const readJson = name => JSON.parse(readFileSync(join(OUT, name), 'utf8'));
const writeJson = (name, value) => writeFileSync(join(OUT, name), JSON.stringify(value));
const log = (...a) => console.error(`[s3 ${new Date().toISOString().slice(11, 19)}]`, ...a);

function testFiles() {
    if (opt('test-files', null))
        return opt('test-files').split(',');
    return readdirSync(join(REPO, TESTS_DIR)).filter(f => f.endsWith('.test.mjs')).sort().map(f => `${TESTS_DIR}/${f}`);
}

/**
 * Runs one command with a wall-clock limit, in its own process group (killed whole on timeout). CPU time comes from
 * /usr/bin/time -p (user + sys of the process and the children it waited for).
 */
function runProcess(argv, { env = {}, timeoutMs = 0, cwd = REPO } = {}) {
    return new Promise(done => {
        const started = process.hrtime.bigint();
        // /usr/bin/time is SIP-protected on macOS, which strips DYLD_* variables; /usr/bin/env puts one back for node.
        const pre = process.env.DYLD_LIBRARY_PATH ? ['/usr/bin/env', `DYLD_LIBRARY_PATH=${process.env.DYLD_LIBRARY_PATH}`] : [];
        const child = spawn('/usr/bin/time', ['-p', ...pre, ...argv], { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', timedOut = false;
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr = (stderr + d).slice(-20000); });
        const timer = timeoutMs ? setTimeout(() => {
            timedOut = true;
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
        }, timeoutMs) : null;
        child.on('close', code => {
            if (timer)
                clearTimeout(timer);
            const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
            const user = Number(/^user\s+([\d.]+)/m.exec(stderr)?.[1] || 0), sys = Number(/^sys\s+([\d.]+)/m.exec(stderr)?.[1] || 0);
            done({ code, timedOut, wallMs: Math.round(wallMs), cpuMs: Math.round((user + sys) * 1000), stdout, stderr });
        });
    });
}

/** Runs async tasks with at most `jobs` at once; results in input order. */
async function pool(items, jobs, fn) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
        while (next < items.length) {
            const k = next++;
            results[k] = await fn(items[k], k);
        }
    }));
    return results;
}

const parseReport = stdout => stdout.split('\n').filter(l => l.startsWith('{"s"')).map(l => JSON.parse(l));

/** One test file under the hook and the JSON reporter. */
function runTestFile(file, { mutantPath = null, timeoutMs = 0, coverageDir = null } = {}) {
    const env = { NODE_OPTIONS: `--import ${join(HERE, 'hook.mjs')}`, CUPEL_MUTANT: mutantPath || '' };
    if (coverageDir)
        env.NODE_V8_COVERAGE = coverageDir;
    return runProcess([NODE, '--test', '--test-isolation=none', `--test-reporter=${join(HERE, 'reporter.mjs')}`, file], { env, timeoutMs });
}

// ---------------------------------------------------------------- select

/** Static import closure of a test file (import ... from '...', import('...') with a literal). */
function importClosure(file, cache = new Map()) {
    const seen = new Set();
    const stack = [resolve(REPO, file)];
    while (stack.length) {
        const f = stack.pop();
        if (seen.has(f) || !existsSync(f) || !/\.m?js$/.test(f))
            continue;
        seen.add(f);
        let deps = cache.get(f);
        if (!deps) {
            const src = readFileSync(f, 'utf8');
            deps = [];
            for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g))
                deps.push(resolve(dirname(f), m[2]));
            cache.set(f, deps);
        }
        stack.push(...deps);
    }
    return [...seen].map(f => relative(REPO, f));
}

async function select() {
    const files = testFiles();
    const covRoot = join(OUT, 'cov-raw');
    rmSync(covRoot, { recursive: true, force: true });
    const cache = new Map();
    const imports = {};
    for (const f of files)
        imports[f] = importClosure(f, cache).filter(p => targets.some(t => t.file === p));
    writeJson('imports.json', imports);
    const urls = new Set(targets.map(t => t.url));
    const coverage = {};
    const timing = {};
    let done = 0;
    const t0 = Date.now();
    const runs = await pool(files, JOBS, async (file, k) => {
        const dir = join(covRoot, String(k));
        const r = await runTestFile(file, { coverageDir: dir, timeoutMs: 600000 });
        timing[file] = { wallMs: r.wallMs, cpuMs: r.cpuMs, code: r.code };
        const entry = {};
        if (existsSync(dir)) {
            for (const name of readdirSync(dir)) {
                const json = JSON.parse(readFileSync(join(dir, name), 'utf8'));
                for (const script of json.result || []) {
                    const url = script.url.split('?')[0];
                    if (!urls.has(url))
                        continue;
                    const ranges = script.functions.flatMap(fn => fn.ranges.map(r => [r.startOffset, r.endOffset, r.count]));
                    entry[url] = entry[url] ? mergeRanges(entry[url], ranges) : ranges;
                }
            }
            rmSync(dir, { recursive: true, force: true });
        }
        if (Object.keys(entry).length)
            coverage[file] = entry;
        if (++done % 25 === 0)
            log(`select ${done}/${files.length}`);
        return r;
    });
    writeJson('coverage.json', coverage);
    writeJson('select-timing.json', { jobs: JOBS, wallMs: Date.now() - t0, cpuMs: runs.reduce((n, r) => n + r.cpuMs, 0), files: timing });
    log(`select: ${files.length} files, ${Object.keys(coverage).length} cover a target, ${Math.round((Date.now() - t0) / 1000)} s`);
}

/** Two processes' ranges for the same script: concatenate (the innermost lookup takes the max count of equal ranges). */
function mergeRanges(a, b) {
    return a.concat(b);
}

/** The count of the innermost covered range containing `offset` (max over equal ranges from several processes). */
export function countAt(ranges, offset) {
    let best = null, bestLen = Infinity, count = 0;
    for (const [s, e, c] of ranges) {
        if (offset < s || offset >= e)
            continue;
        const len = e - s;
        if (len < bestLen) {
            best = [s, e];
            bestLen = len;
            count = c;
        }
        else if (len === bestLen && best && s === best[0])
            count = Math.max(count, c);
    }
    return count;
}

// ---------------------------------------------------------------- baseline

async function baseline() {
    const coverage = readJson('coverage.json');
    const files = Object.keys(coverage).sort();
    const t0 = Date.now();
    const out = {};
    await pool(files, JOBS, async file => {
        const r = await runTestFile(file, { timeoutMs: 600000 });
        const tests = parseReport(r.stdout);
        out[file] = { wallMs: r.wallMs, cpuMs: r.cpuMs, code: r.code, tests: tests.length, failed: tests.filter(t => t.s === 'fail').map(t => t.t) };
    });
    const failing = files.filter(f => out[f].code !== 0 || out[f].failed.length);
    writeJson('baseline.json', { jobs: JOBS, wallMs: Date.now() - t0, cpuMs: files.reduce((n, f) => n + out[f].cpuMs, 0), failing, files: out });
    log(`baseline: ${files.length} files in ${Math.round((Date.now() - t0) / 1000)} s; failing: ${failing.join(', ') || 'none'}`);
}

// ---------------------------------------------------------------- mutants

async function mutants() {
    const coverage = readJson('coverage.json');
    const base = readJson('baseline.json');
    const imports = readJson('imports.json');
    const usable = Object.keys(coverage).filter(f => !base.failing.includes(f));
    const modules = {};
    const lexer = {};
    for (const [module, files] of Object.entries(CONFIG.modules)) {
        const all = [];
        for (const file of files) {
            const source = readFileSync(join(REPO, file), 'utf8');
            const url = pathToFileURL(join(REPO, file)).href;
            const t0 = process.hrtime.bigint();
            const list = generateMutants(file, source);
            const genMs = Number(process.hrtime.bigint() - t0) / 1e6;
            let invalid = 0;
            const t1 = process.hrtime.bigint();
            for (const m of list) {
                m.invalid = await validate(applyMutant(source, m));
                if (m.invalid)
                    invalid++;
            }
            const valMs = Number(process.hrtime.bigint() - t1) / 1e6;
            lexer[file] = { lines: source.split('\n').length, generated: list.length, invalid, generateMs: Math.round(genMs), validateMs: Math.round(valMs) };
            // Line coverage of this file by all covering test files (union), over lines where a token starts.
            const codeLines = new Map();
            for (const tok of tokenize(source))
                if (!codeLines.has(tok.line))
                    codeLines.set(tok.line, tok.start);
            const union = usable.flatMap(f => coverage[f][url] || []);
            let covered = 0;
            for (const offset of codeLines.values())
                if (union.length && countAt(union, offset) > 0)
                    covered++;
            lexer[file].codeLines = codeLines.size;
            lexer[file].coveredLines = covered;
            for (const m of list) {
                m.module = module;
                m.url = url;
                const sel = usable.map(f => ({ f, c: coverage[f][url] ? countAt(coverage[f][url], m.start) : 0 })).filter(x => x.c > 0);
                // Order: direct or transitive importers by hits at the mutant's block (most first), then fastest first.
                sel.sort((a, b) => (b.c - a.c) || (base.files[a.f].wallMs - base.files[b.f].wallMs) || (a.f < b.f ? -1 : 1));
                m.tests = sel.map(x => x.f);
                m.importers = usable.filter(f => imports[f]?.includes(file)).length;
            }
            all.push(...list);
        }
        const eligible = all.filter(m => !m.invalid && !m.filtered);
        const chosen = sample(eligible, CONFIG.capPerModule, SEED);
        modules[module] = {
            files, generated: all.length, invalid: all.filter(m => m.invalid).length, filtered: all.filter(m => m.filtered).length,
            eligible: eligible.length, sampled: chosen.length, seed: SEED,
            importSelectedFiles: usable.filter(f => files.some(file => imports[f]?.includes(file))).length,
            coverageSelectedFiles: usable.filter(f => files.some(file => coverage[f][pathToFileURL(join(REPO, file)).href]?.some(r => r[2] > 0))).length,
            mutants: chosen, all: all.map(({ id, op, filtered, invalid, line }) => ({ id, op, filtered, invalid, line }))
        };
        log(`${module}: generated ${all.length}, invalid ${modules[module].invalid}, filtered ${modules[module].filtered}, sampled ${chosen.length}; mean selected files ${(chosen.reduce((n, m) => n + m.tests.length, 0) / chosen.length).toFixed(1)}`);
    }
    writeJson('mutants.json', { seed: SEED, capPerModule: CONFIG.capPerModule, lexer, modules });
}

// ---------------------------------------------------------------- run

async function runMutants({ recheck = false } = {}) {
    const { modules } = readJson('mutants.json');
    const base = readJson('baseline.json');
    const resultsPath = join(OUT, recheck ? 'recheck.jsonl' : 'results.jsonl');
    // Resumable: a mutant already in the results is skipped, unless it ended in an environment error (re-run it).
    const done = new Set(existsSync(resultsPath) ? readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.status !== 'error').map(r => r.id) : []);
    // recheck: only the mutants whose first run timed out, again, with a longer limit (a timeout under heavy load
    // may be the machine, not the mutant).
    const timedOut = recheck ? new Set(readFileSync(join(OUT, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.status === 'timeout').map(r => r.id)) : null;
    const factor = recheck ? CONFIG.recheckTimeoutFactor || 10 : CONFIG.timeoutFactor;
    const work = join(OUT, 'mutants');
    mkdirSync(work, { recursive: true });
    // Preflight: the fastest covering file must still pass unmutated here, or every file run would count as a kill.
    const probe = Object.keys(base.files).filter(f => !base.failing.includes(f)).sort((a, b) => base.files[a].wallMs - base.files[b].wallMs)[0];
    const pre = await runTestFile(probe, { timeoutMs: 120000 });
    const preTests = parseReport(pre.stdout);
    if (pre.code !== 0 || !preTests.length || preTests.some(t => t.s === 'fail'))
        throw new Error(`preflight failed: ${probe} unmutated exited ${pre.code} with ${preTests.length} tests\n${pre.stderr.slice(-1500)}`);
    const runLog = [];
    for (const [module, info] of Object.entries(modules)) {
        if (ONLY && module !== ONLY)
            continue;
        const deadline = Date.now() + CONFIG.minutesPerModule * 60000;
        const todo = info.mutants.filter(m => !done.has(m.id) && (!timedOut || timedOut.has(m.id)));
        if (!todo.length)
            continue;
        const t0 = Date.now();
        let count = 0, cpu = 0;
        log(`${module}: ${todo.length} mutants to run (${info.mutants.length - todo.length} already done)`);
        await pool(todo, JOBS, async (m, k) => {
            const record = { id: m.id, module, file: m.file, op: m.op, line: m.line, col: m.col, original: m.original, replacement: m.replacement, selected: m.tests.length };
            if (Date.now() > deadline) {
                appendFileSync(resultsPath, `${JSON.stringify({ ...record, status: 'not-run' })}\n`);
                return;
            }
            const source = applyMutant(readFileSync(join(REPO, m.file), 'utf8'), m);
            const specPath = join(work, `${module}-${k}.json`), seenPath = join(work, `${module}-${k}.seen`);
            rmSync(seenPath, { force: true });
            writeFileSync(specPath, JSON.stringify({ url: m.url, source, seen: seenPath }));
            const started = Date.now();
            const files = [];
            let killingFiles = 0, ran = 0, cpuMs = 0, errors = 0;
            for (const file of m.tests) {
                if (STOP_AFTER && killingFiles >= STOP_AFTER)
                    break;
                const baseMs = base.files[file].wallMs;
                const timeoutMs = Math.max(factor * baseMs, CONFIG.timeoutFloorMs);
                const r = await runTestFile(file, { mutantPath: specPath, timeoutMs });
                ran++;
                cpuMs += r.cpuMs;
                const tests = parseReport(r.stdout);
                const failed = tests.filter(t => t.s === 'fail');
                // A kill needs a failing test in the reporter's output (a module that fails to load is reported as
                // a failing test named after the file). A timeout counts as a kill, reported apart. A process that
                // exits non-zero without reporting a failure (node crashing at startup, a dyld error, OOM) is an
                // environment error: neither a kill nor a survival, and the mutant is marked for a re-run.
                const killed = failed.length > 0 || r.timedOut;
                const error = !killed && (r.code !== 0 || !tests.length);
                if (killed)
                    killingFiles++;
                if (error)
                    errors++;
                files.push({ file, ms: r.wallMs, killed, timedOut: r.timedOut, error, code: r.code, events: tests.length, failed: failed.map(t => t.t), errors: failed.slice(0, 2).map(t => t.e), ...(error ? { stderr: r.stderr.slice(-400) } : {}) });
            }
            const loaded = existsSync(seenPath);
            const killers = files.filter(f => f.killed);
            const status = !m.tests.length ? 'no-coverage' : killers.some(f => !f.timedOut) ? 'killed' : killers.length ? 'timeout' : errors ? 'error' : 'survived';
            const result = { ...record, status, loaded, ran, killingFiles: killers.length, errorFiles: errors, complete: ran === m.tests.length, startedAt: new Date(started).toISOString(), wallMs: Date.now() - started, cpuMs, files: files.filter(f => f.killed || f.timedOut || f.error) };
            appendFileSync(resultsPath, `${JSON.stringify(result)}\n`);
            count++;
            cpu += cpuMs;
            if (count % 10 === 0)
                log(`${module}: ${count}/${todo.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
        });
        runLog.push({ module, jobs: JOBS, stopAfterFiles: STOP_AFTER, mutantsRun: count, wallMs: Date.now() - t0, cpuMs: cpu });
        log(`${module}: ran ${count} in ${Math.round((Date.now() - t0) / 1000)} s`);
    }
    const logName = recheck ? 'recheck-log.json' : 'run-log.json';
    const prior = existsSync(join(OUT, logName)) ? readJson(logName) : [];
    writeJson(logName, [...prior, ...runLog]);
}

// ---------------------------------------------------------------- report

const sourceLines = new Map();
function sourceLine(file, line) {
    if (!sourceLines.has(file))
        sourceLines.set(file, readFileSync(join(REPO, file), 'utf8').split('\n'));
    return sourceLines.get(file)[line - 1].trim().slice(0, 160);
}

function report() {
    const { modules, lexer, seed } = readJson('mutants.json');
    const results = readFileSync(join(OUT, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const byId = new Map(results.map(r => [r.id, r]));
    // A timeout re-run with a longer limit replaces the first result (both are kept in the summary counts).
    const recheckPath = join(OUT, 'recheck.jsonl');
    const rechecks = existsSync(recheckPath) ? readFileSync(recheckPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    for (const r of rechecks)
        if (byId.get(r.id)?.status === 'timeout')
            byId.set(r.id, { ...r, firstStatus: 'timeout' });
    // Re-derive every status with the strict rule (a kill needs a reported failing test; a timeout is apart; a
    // non-zero exit with no reported failure is an environment error), so records written before the rule agree.
    for (const [id, r] of byId) {
        if (!['killed', 'timeout'].includes(r.status))
            continue;
        const files = r.files.map(f => ({ ...f, killed: f.failed.length > 0 || f.timedOut, error: f.error || (!f.timedOut && !f.failed.length) }));
        const killers = files.filter(f => f.killed);
        const status = killers.some(f => !f.timedOut) ? 'killed' : killers.length ? 'timeout' : 'error';
        if (status !== r.status || killers.length !== r.killingFiles)
            byId.set(id, { ...r, status, files, killingFiles: killers.length, statusBefore: r.status });
    }
    const runLog = existsSync(join(OUT, 'run-log.json')) ? readJson('run-log.json') : [];
    const summary = { seed, modules: {}, uniqueTests: {}, uniqueFiles: {}, survivors: [], lexer };
    for (const [module, info] of Object.entries(modules)) {
        const rs = info.mutants.map(m => byId.get(m.id)).filter(Boolean);
        const n = s => rs.filter(r => r.status === s).length;
        const killed = n('killed'), timeout = n('timeout'), survived = n('survived'), noCov = n('no-coverage'), notRun = n('not-run'), errored = n('error');
        const scored = killed + timeout + survived + noCov;
        const logs = runLog.filter(l => l.module === module);
        const wallMs = logs.reduce((a, l) => a + l.wallMs, 0), cpuMs = logs.reduce((a, l) => a + l.cpuMs, 0), ran = logs.reduce((a, l) => a + l.mutantsRun, 0);
        summary.modules[module] = {
            files: info.files, generated: info.generated, invalid: info.invalid, filtered: info.filtered, eligible: info.eligible, sampled: info.sampled,
            killed, timeout, survived, noCoverage: noCov, notRun, environmentErrors: errored,
            score: scored ? Math.round(1000 * (killed + timeout) / scored) / 10 : null,
            scoreCovered: (killed + timeout + survived) ? Math.round(1000 * (killed + timeout) / (killed + timeout + survived)) / 10 : null,
            notLoaded: rs.filter(r => r.status === 'survived' && !r.loaded).length,
            firstRunTimeouts: rs.filter(r => r.firstStatus === 'timeout' || (r.status === 'timeout' && !r.firstStatus)).length,
            timeoutsAfterRecheck: rs.filter(r => r.firstStatus === 'timeout' && r.status === 'timeout').length,
            timeoutsKilledOnRecheck: rs.filter(r => r.firstStatus === 'timeout' && r.status === 'killed').length,
            timeoutsSurvivedOnRecheck: rs.filter(r => r.firstStatus === 'timeout' && r.status === 'survived').length,
            importSelectedFiles: info.importSelectedFiles, coverageSelectedFiles: info.coverageSelectedFiles,
            meanSelectedFiles: Math.round(10 * info.mutants.reduce((a, m) => a + m.tests.length, 0) / info.mutants.length) / 10,
            meanFilesRun: rs.length ? Math.round(10 * rs.reduce((a, r) => a + (r.ran || 0), 0) / rs.length) / 10 : 0,
            wallMs, cpuMs, mutantsPerMinute: wallMs ? Math.round(10 * ran / (wallMs / 60000)) / 10 : null,
            cpuSecondsPerMutant: ran ? Math.round(cpuMs / ran / 100) / 10 : null,
            byOperator: {}
        };
        for (const r of rs) {
            const o = summary.modules[module].byOperator[r.op] ||= { run: 0, killed: 0, survived: 0 };
            o.run++;
            if (r.status === 'killed' || r.status === 'timeout')
                o.killed++;
            if (r.status === 'survived' || r.status === 'no-coverage')
                o.survived++;
        }
        for (const r of rs) {
            if (r.status === 'survived' || r.status === 'no-coverage')
                summary.survivors.push({ id: r.id, module, file: r.file, line: r.line, op: r.op, original: r.original, replacement: r.replacement, status: r.status, selected: r.selected, loaded: r.loaded, code: sourceLine(r.file, r.line) });
            if (r.status === 'timeout')
                (summary.timeouts ||= []).push({ id: r.id, module, code: sourceLine(r.file, r.line), files: r.files.map(f => f.file) });
            if (r.status !== 'killed' && r.status !== 'timeout' || !r.complete || r.killingFiles !== 1)
                continue;
            const f = r.files.find(x => x.killed);
            (summary.uniqueFiles[f.file] ||= []).push(r.id);
            const tests = f.timedOut ? [] : f.failed.length ? f.failed : ['<file-level failure>'];
            if (tests.length === 1)
                (summary.uniqueTests[`${f.file} :: ${tests[0]}`] ||= []).push(r.id);
        }
    }
    writeJson('summary.json', summary);
    if (args.includes('--survivors')) {
        for (const v of summary.survivors)
            console.log(`${v.status.padEnd(11)} ${v.file}:${v.line} ${v.op} ${JSON.stringify(v.original)}->${JSON.stringify(v.replacement)} sel=${v.selected} | ${v.code}`);
        for (const t of summary.timeouts || [])
            console.log(`timeout     ${t.id} | ${t.code} | ${t.files.join(' ')}`);
        return;
    }
    console.log(JSON.stringify({ modules: Object.fromEntries(Object.entries(summary.modules).map(([k, v]) => [k, { ...v, byOperator: undefined }])), uniqueFiles: Object.fromEntries(Object.entries(summary.uniqueFiles).map(([k, v]) => [k, v.length])), uniqueTests: Object.fromEntries(Object.entries(summary.uniqueTests).map(([k, v]) => [k, v.length])), survivors: summary.survivors.length }, null, 1));
}

const phases = { select, baseline, mutants, run: runMutants, recheck: () => runMutants({ recheck: true }), report };
if (phase === 'all') {
    for (const p of ['select', 'baseline', 'mutants', 'run', 'recheck', 'report'])
        await phases[p]();
}
else if (phases[phase])
    await phases[phase]();
else {
    console.error('usage: node run.mjs <select|baseline|mutants|run|recheck|report|all> --repo <suite> --out <dir> [--config f] [--jobs n] [--seed n] [--only module] [--stop-after-files n]');
    process.exit(2);
}
