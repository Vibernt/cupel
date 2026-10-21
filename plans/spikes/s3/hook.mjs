/**
 * Serves one mutant in place of one module, without touching the file on disk (spike S3).
 *
 * Loaded with NODE_OPTIONS="--import <abs path to this file>" so it also applies inside child processes the tests
 * start. CUPEL_MUTANT names a JSON file { url, source, seen }: when `url` (a file: URL, query string ignored) is
 * loaded, `source` is served instead, and the process id is appended to `seen`, so the runner knows the mutant was
 * actually loaded. Without CUPEL_MUTANT the hook does nothing (the baseline runs).
 */
import { registerHooks } from 'node:module';
import { readFileSync, appendFileSync } from 'node:fs';

const path = process.env.CUPEL_MUTANT;
if (path) {
    const spec = JSON.parse(readFileSync(path, 'utf8'));
    registerHooks({
        load(url, context, next) {
            if (url.split('?')[0] === spec.url) {
                if (spec.seen)
                    appendFileSync(spec.seen, `${process.pid}\n`);
                return { format: 'module', source: spec.source, shortCircuit: true };
            }
            return next(url, context);
        }
    });
}
