/**
 * S1 spike, step 4: unique coverage per test file, import inflation, subsets, cost.
 *
 *   node plans/spikes/s1/analyze.mjs --assay <suite root> --out <dir> [--csv <dir for committed CSVs>]
 *
 * Inputs (from collect.mjs, reduce.mjs and loadonly.mjs): <out>/runs.jsonl, optional <out>/runs-nocov.jsonl,
 * <out>/lines-cov/*.json (scope src-public), optional <out>/lines-cov-repo/*.json (scope repo),
 * optional <out>/lines-cov-load/*.json (load-only lines), <out>/collect*.json, <out>/reduce-cov.json.
 * Outputs: <out>/analysis.json (everything), <out>/tables.md (Markdown tables for S1.md) and, with --csv,
 * <csv>/files.csv (one row per test file), <csv>/zero-unique.csv (files with no unique line) and <csv>/summary.json.
 * Definitions: a line is "path:line" under the rule in lines.mjs. A file's unique lines are lines no other test
 * file covers. Load-only lines are lines covered by merely importing some module (loadonly.mjs). Deterministic:
 * every list is sorted by a value, then by name.
 * Standard library only.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { tableFor } from './lines.mjs';

const { values } = parseArgs({ options: { assay: { type: 'string' }, out: { type: 'string' }, csv: { type: 'string' } } });
if (!values.assay || !values.out) { console.error('usage: analyze.mjs --assay <dir> --out <dir> [--csv <dir>]'); process.exit(2); }
const root = resolve(values.assay), out = resolve(values.out);
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const readJsonIf = p => existsSync(p) ? readJson(p) : null;
const jsonl = p => existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const byName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
const cpuOf = f => f.user + f.sys;
const sumBy = (list, fn) => list.reduce((a, f) => a + fn(f), 0);
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };

function walk(dir, skip, acc = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = join(dir, e.name), rel = p.slice(root.length + 1);
        if (skip(rel)) continue;
        if (e.isDirectory()) walk(p, skip, acc); else if (/\.(mjs|cjs|js)$/.test(e.name)) acc.push(rel);
    }
    return acc;
}
const scopes = {
    'src-public': { lines: 'lines-cov', sources: () => [...walk(resolve(root, 'src'), () => false), ...walk(resolve(root, 'public'), () => false)] },
    repo: { lines: 'lines-cov-repo', sources: () => walk(root, rel => rel === 'tests') }
};

const runs = jsonl(resolve(out, 'runs.jsonl')).sort(byName);
const nocov = new Map(jsonl(resolve(out, 'runs-nocov.jsonl')).map(r => [r.name.replace(/-nocov$/, ''), r]));
const totalCpu = sumBy(runs, cpuOf);
const group = list => ({ files: list.length, tests: sumBy(list, f => f.tests || 0), wallMs: sumBy(list, f => f.wallMs),
    cpuS: +sumBy(list, cpuOf).toFixed(1), cpuShare: +(sumBy(list, cpuOf) / totalCpu).toFixed(3) });

function analyzeScope(scope) {
    const conf = scopes[scope], linesDir = resolve(out, conf.lines);
    if (!existsSync(linesDir)) return null;
    const sources = conf.sources().sort();
    let universe = 0, universePunct = 0;
    for (const s of sources) { const t = tableFor(`${root}/${s}`); if (!t) continue; for (let l = 1; l <= t.lines; l++) { universe += t.coverable[l]; universePunct += t.punct[l]; } }
    const ids = new Map(), keys = [], punctId = [];
    const idOf = (p, l) => {
        const k = `${p}:${l}`; let id = ids.get(k);
        if (id === undefined) { id = keys.length; ids.set(k, id); keys.push(k); punctId.push(tableFor(`${root}/${p}`)?.punct[l] ?? 0); }
        return id;
    };
    const files = runs.map(r => {
        const p = resolve(linesDir, `${r.name}.json`), plain = existsSync(p) ? readJson(p) : {}, set = [];
        for (const [path, lines] of Object.entries(plain)) for (const l of lines) set.push(idOf(path, l));
        return { ...r, set: Uint32Array.from(set).sort(), sourceFiles: Object.keys(plain).length };
    });
    const loadDir = resolve(out, 'lines-cov-load'), load = new Set();
    if (existsSync(loadDir)) for (const f of readdirSync(loadDir).sort()) for (const [p, ls] of Object.entries(readJson(resolve(loadDir, f)))) for (const l of ls) load.add(idOf(p, l));

    const N = keys.length, cnt = new Uint16Array(N), isLoad = new Uint8Array(N);
    for (const f of files) for (const id of f.set) cnt[id]++;
    for (const id of load) isLoad[id] = 1;
    let covered = 0, coveredLoad = 0, unique = 0, uniqueLoad = 0, uniquePunct = 0;
    for (let id = 0; id < N; id++) if (cnt[id]) { covered++; coveredLoad += isLoad[id]; if (cnt[id] === 1) { unique++; uniqueLoad += isLoad[id]; uniquePunct += punctId[id]; } }
    for (const f of files) {
        let u = 0, uNoLoad = 0, cNoLoad = 0, uPunct = 0;
        for (const id of f.set) { if (!isLoad[id]) cNoLoad++; if (cnt[id] === 1) { u++; uPunct += punctId[id]; if (!isLoad[id]) uNoLoad++; } }
        Object.assign(f, { covered: f.set.length, coveredNoLoad: cNoLoad, unique: u, uniqueNoLoad: uNoLoad, uniquePunct: uPunct,
            loadShare: f.set.length ? (f.set.length - cNoLoad) / f.set.length : 0 });
    }

    // Subsets: is a file's set contained in one other file's set? Bitsets over line ids.
    const W = Math.ceil(N / 32);
    const bitsetOf = (f, skipLoad) => { const b = new Uint32Array(W); for (const id of f.set) if (!skipLoad || !isLoad[id]) b[id >>> 5] |= 1 << (id & 31); return b; };
    const bits = files.map(f => bitsetOf(f, false)), bitsNoLoad = files.map(f => bitsetOf(f, true));
    const subsetOf = (i, bs, size) => {
        if (!size) return null;
        const a = bs[i]; let best = null;
        for (let j = 0; j < files.length; j++) {
            if (j === i) continue;
            const b = bs[j]; let ok = true;
            for (let w = 0; w < W; w++) if ((a[w] & ~b[w]) !== 0) { ok = false; break; }
            if (ok && (!best || files[j].covered < best.size)) best = { name: files[j].name, size: files[j].covered };
        }
        return best;
    };
    for (let i = 0; i < files.length; i++) {
        const f = files[i], s = subsetOf(i, bits, f.covered);
        f.subsetOf = s?.name ?? ''; f.equalTo = s && s.size === f.covered ? s.name : '';
        f.subsetOfNoLoad = subsetOf(i, bitsNoLoad, f.coveredNoLoad)?.name ?? '';
    }

    // Joint removal: the lines lost if every zero-unique file is removed at once, and a greedy set cover.
    const zero = files.filter(f => f.unique === 0), keep = new Uint8Array(N);
    for (const f of files) if (f.unique > 0) for (const id of f.set) keep[id] = 1;
    let lostIfZeroRemoved = 0; for (let id = 0; id < N; id++) if (cnt[id] && !keep[id]) lostIfZeroRemoved++;
    const greedy = () => {
        const need = new Uint8Array(N); let left = 0;
        for (let id = 0; id < N; id++) if (cnt[id]) { need[id] = 1; left++; }
        const chosen = [], taken = new Uint8Array(files.length);
        while (left > 0) {
            let best = -1, gain = 0;
            for (let i = 0; i < files.length; i++) { if (taken[i]) continue; let g = 0; for (const id of files[i].set) g += need[id]; if (g > gain) { gain = g; best = i; } }
            taken[best] = 1; chosen.push(files[best]);
            for (const id of files[best].set) if (need[id]) { need[id] = 0; left--; }
        }
        return { files: chosen.length, wallMs: sumBy(chosen, f => f.wallMs), cpuS: +sumBy(chosen, cpuOf).toFixed(1) };
    };

    const BUCKETS = ['0', '1-9', '10-49', '50-99', '100-499', '500-999', '1000+'];
    const bucketOf = u => u === 0 ? '0' : u < 10 ? '1-9' : u < 50 ? '10-49' : u < 100 ? '50-99' : u < 500 ? '100-499' : u < 1000 ? '500-999' : '1000+';
    const hist = k => Object.fromEntries(BUCKETS.map(b => [b, files.filter(f => bucketOf(f[k]) === b).length]));
    const percentiles = k => Object.fromEntries([0.25, 0.5, 0.75, 0.9, 0.99].map(p => [`p${p * 100}`, pct(files.map(f => f[k]), p)]));
    const empty = files.filter(f => f.covered === 0), shared = files.filter(f => f.covered > 0 && f.unique === 0);
    const summary = {
        scope, sourceFiles: sources.length, coverableLines: universe, coverablePunctOnly: universePunct,
        coveredLines: covered, coveredShare: +(covered / universe).toFixed(4),
        uniqueLines: unique, uniqueShareOfCovered: +(unique / covered).toFixed(4), uniquePunctOnly: uniquePunct,
        loadOnlyLines: load.size, loadOnlyCoveredBySuite: coveredLoad, uniqueLoadOnly: uniqueLoad, coveredNonLoad: covered - coveredLoad, uniqueNonLoad: unique - uniqueLoad,
        zeroUnique: group(zero), zeroUniqueCoversNothing: group(empty), zeroUniqueFullyShared: group(shared),
        zeroUniqueNoLoad: group(files.filter(f => f.uniqueNoLoad === 0)), coversOnlyLoadLines: group(files.filter(f => f.covered > 0 && f.coveredNoLoad === 0)),
        linesLostIfAllZeroUniqueRemoved: lostIfZeroRemoved,
        subsetOfAnother: group(files.filter(f => f.subsetOf)), equalToAnother: files.filter(f => f.equalTo).length,
        subsetOfAnotherNoLoad: group(files.filter(f => f.subsetOfNoLoad)),
        greedyCover: greedy(), histUnique: hist('unique'), histUniqueNoLoad: hist('uniqueNoLoad'),
        uniquePercentiles: percentiles('unique'), uniqueNoLoadPercentiles: percentiles('uniqueNoLoad'),
        loadSharePercentiles: Object.fromEntries([0.1, 0.25, 0.5, 0.75, 0.9].map(p => [`p${p * 100}`, +pct(files.filter(f => f.covered).map(f => f.loadShare), p).toFixed(3)])),
        uniqueOnlyPunctuationLines: files.filter(f => f.unique > 0 && f.unique === f.uniquePunct).map(f => f.name)
    };
    return { summary, files: new Map(files.map(f => [f.name, f])), empty, shared };
}

const main = analyzeScope('src-public'), repo = analyzeScope('repo');
const files = [...main.files.values()];
const collect = readJsonIf(resolve(out, 'collect.json')), reduce = readJsonIf(resolve(out, 'reduce-cov.json')), load = readJsonIf(resolve(out, 'loadonly.json'));
const lineSetBytes = files.reduce((a, f) => { const p = resolve(out, 'lines-cov', `${f.name}.json`); return a + (existsSync(p) ? readFileSync(p).length : 0); }, 0);
const summary = {
    testFiles: files.length, tests: sumBy(files, f => f.tests || 0), pass: sumBy(files, f => f.pass || 0), failed: sumBy(files, f => f.fail || 0),
    skipped: sumBy(files, f => f.skipped || 0), nonZeroExit: files.filter(f => f.exit !== 0).map(f => f.name),
    srcPublic: main.summary, repo: repo?.summary ?? null,
    perFileWallMs: { p50: pct(files.map(f => f.wallMs), 0.5), p90: pct(files.map(f => f.wallMs), 0.9), max: Math.max(...files.map(f => f.wallMs)), sum: sumBy(files, f => f.wallMs) },
    perFileCpuS: { p50: pct(files.map(cpuOf), 0.5), p90: pct(files.map(cpuOf), 0.9), max: Math.max(...files.map(cpuOf)), sum: +totalCpu.toFixed(1) },
    collect, collectNocov: readJsonIf(resolve(out, 'collect-nocov.json')),
    coverageData: reduce && { rawBytes: reduce.rawBytes, rawFiles: reduce.rawFiles, reduceMs: reduce.reduceMs, lineSetBytes },
    loadonly: load && { modules: load.modules, ok: load.ok, failed: load.failed, jobs: load.jobs, wallMs: load.wallMs,
        failedModules: Object.entries(load.results).filter(([, r]) => r.status !== 'OK').map(([m, r]) => `${m}: ${r.status.replaceAll(root + '/', '')}`) }
};

const cols = ['file', 'tests', 'pass', 'fail', 'skipped', 'exit', 'wallMs', 'cpuS', 'nocovWallMs', 'nocovCpuS', 'sourceFiles', 'covered', 'coveredNoLoad',
    'unique', 'uniqueNoLoad', 'subsetOf', 'equalTo', 'subsetOfNoLoad', 'repoCovered', 'repoUnique', 'repoSubsetOf'];
const row = f => {
    const r = repo?.files.get(f.name), n = nocov.get(f.name);
    return { file: f.file, tests: f.tests, pass: f.pass, fail: f.fail, skipped: f.skipped, exit: f.exit, wallMs: f.wallMs, cpuS: +cpuOf(f).toFixed(2),
        nocovWallMs: n?.wallMs ?? '', nocovCpuS: n ? +cpuOf(n).toFixed(2) : '', sourceFiles: f.sourceFiles, covered: f.covered, coveredNoLoad: f.coveredNoLoad,
        unique: f.unique, uniqueNoLoad: f.uniqueNoLoad, subsetOf: f.subsetOf, equalTo: f.equalTo, subsetOfNoLoad: f.subsetOfNoLoad,
        repoCovered: r?.covered ?? '', repoUnique: r?.unique ?? '', repoSubsetOf: r?.subsetOf ?? '' };
};
const csv = list => [cols.join(','), ...list.map(f => cols.map(c => String(row(f)[c] ?? '')).join(','))].join('\n') + '\n';
const zeroList = [...main.empty, ...main.shared].sort((a, b) => cpuOf(b) - cpuOf(a) || byName(a, b));
if (values.csv) {
    mkdirSync(resolve(values.csv), { recursive: true });
    writeFileSync(resolve(values.csv, 'files.csv'), csv(files));
    writeFileSync(resolve(values.csv, 'zero-unique.csv'), csv(zeroList));
    writeFileSync(resolve(values.csv, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
}
writeFileSync(resolve(out, 'analysis.json'), JSON.stringify({ summary, files: files.map(row) }, null, 1));

// Markdown tables for the write-up.
const md = [], short = f => f.file.replace('tests/', '').replace('.test.mjs', '');
const t = (head, rows) => md.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`), '');
md.push('## Zero unique lines (src/public), by CPU, top 40', '');
t(['Test file', 'Tests', 'Kind', 'Covered', 'Covered, non-load', 'Subset of (smallest)', 'Unique, repo scope', 'Wall ms', 'CPU s'], zeroList.slice(0, 40).map(f =>
    [short(f), f.tests, f.covered ? 'shared' : 'nothing', f.covered, f.coveredNoLoad, f.equalTo ? `equal to ${f.equalTo}` : f.subsetOf, repo?.files.get(f.name)?.unique ?? '', f.wallMs, cpuOf(f).toFixed(2)]));
md.push('## Slowest files', '');
t(['Test file', 'Tests', 'Wall ms', 'CPU s', 'Wall ms without coverage', 'Unique', 'Unique, non-load'], [...files].sort((a, b) => b.wallMs - a.wallMs || byName(a, b)).slice(0, 15).map(f =>
    [short(f), f.tests, f.wallMs, cpuOf(f).toFixed(2), nocov.get(f.name)?.wallMs ?? '', f.unique, f.uniqueNoLoad]));
md.push('## Most unique lines', '');
t(['Test file', 'Tests', 'Covered', 'Covered, non-load', 'Unique', 'Wall ms'], [...files].sort((a, b) => b.unique - a.unique || byName(a, b)).slice(0, 10).map(f =>
    [short(f), f.tests, f.covered, f.coveredNoLoad, f.unique, f.wallMs]));
md.push('## Subset of another single file (src/public)', '');
t(['Test file', 'Covered', 'Subset of (smallest)', 'Equal'], files.filter(f => f.subsetOf).map(f => [short(f), f.covered, f.subsetOf, f.equalTo ? 'yes' : '']));
writeFileSync(resolve(out, 'tables.md'), md.join('\n'));
console.log(JSON.stringify(summary, null, 1));
