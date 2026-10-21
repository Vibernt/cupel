/**
 * File-mode check (spike S3): the runner serves mutants through a module hook and never writes the suite's files, so
 * a test that reads a source file as text (a "source pin") sees the original. This script measures what that misses:
 * for the given mutants it writes each mutant to disk, runs the given test files, and restores the original bytes at
 * once (checked by SHA-256; also on Ctrl-C). Run it only when nothing else is running against the suite.
 *
 *   node plans/spikes/s3/file-mode.mjs --repo <suite> --out <dir> --module <name> [--file src/x.mjs] --tests a.test.mjs,b.test.mjs
 *
 * Reads <out>/mutants.json; prints and writes <out>/file-mode.json: per mutant, which of the tests fail on disk.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMutant } from './mutate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = name => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const REPO = resolve(opt('repo')), OUT = resolve(opt('out'));
const tests = opt('tests').split(',');
const { modules } = JSON.parse(readFileSync(join(OUT, 'mutants.json'), 'utf8'));
const mutants = modules[opt('module')].mutants.filter(m => !opt('file') || m.file === opt('file'));
const sha = b => createHash('sha256').update(b).digest('hex');

const originals = new Map();
function restoreAll() {
    for (const [file, bytes] of originals) {
        writeFileSync(join(REPO, file), bytes);
        if (sha(readFileSync(join(REPO, file))) !== sha(bytes))
            throw new Error(`restore failed: ${file}`);
    }
}
process.on('SIGINT', () => { restoreAll(); process.exit(130); });
process.on('SIGTERM', () => { restoreAll(); process.exit(143); });

const out = [];
try {
    for (const m of mutants) {
        if (!originals.has(m.file))
            originals.set(m.file, readFileSync(join(REPO, m.file)));
        const original = originals.get(m.file);
        writeFileSync(join(REPO, m.file), applyMutant(original.toString('utf8'), m));
        const failing = {};
        try {
            for (const t of tests) {
                const r = spawnSync(process.execPath, ['--test', '--test-isolation=none', `--test-reporter=${join(HERE, 'reporter.mjs')}`, t], { cwd: REPO, encoding: 'utf8', timeout: 120000 });
                const failed = r.stdout.split('\n').filter(l => l.startsWith('{"s":"fail"')).map(l => JSON.parse(l).t);
                if (failed.length || r.status !== 0)
                    failing[t] = failed;
            }
        }
        finally {
            writeFileSync(join(REPO, m.file), original);
            if (sha(readFileSync(join(REPO, m.file))) !== sha(original))
                throw new Error(`restore failed: ${m.file}`);
        }
        out.push({ id: m.id, failing });
        console.log(m.id, JSON.stringify(failing));
    }
}
finally {
    restoreAll();
}
writeFileSync(join(OUT, 'file-mode.json'), JSON.stringify(out, null, 1));
console.log('restored:', [...originals.keys()].map(f => `${f} ${sha(readFileSync(join(REPO, f))).slice(0, 12)}`).join(', '));
