/**
 * A node:test reporter that prints one JSON line per finished test (spike S3):
 *   {"s":"pass"|"fail"|"skip","t":"suite > test","ms":12.3,"e":"short error"}
 * Suites are not reported, only tests. Use with --test-isolation=none and one file per run, so the names are the
 * file's own test names. Usage: node --test --test-isolation=none --test-reporter=<abs path>/reporter.mjs file.test.mjs
 */
export default async function* reporter(source) {
    const names = [];
    for await (const event of source) {
        if (event.type === 'test:start')
            names[event.data.nesting] = event.data.name;
        else if (event.type === 'test:pass' || event.type === 'test:fail') {
            const d = event.data;
            if (d.details?.type === 'suite')
                continue;
            const t = [...names.slice(0, d.nesting), d.name].join(' > ');
            const s = event.type === 'test:fail' ? 'fail' : d.skip !== undefined || d.todo !== undefined ? 'skip' : 'pass';
            const line = { s, t, ms: Math.round((d.details?.duration_ms || 0) * 10) / 10 };
            if (s === 'fail') {
                const err = d.details?.error;
                line.e = String(err?.cause?.message || err?.message || err || '').split('\n')[0].slice(0, 160);
            }
            yield `${JSON.stringify(line)}\n`;
        }
    }
}
