// A node:test reporter for mutant runs (spike S3): one JSON line per finished test or failed suite, written
// synchronously to the file named by CUPEL_REPORT (never to standard output, where the tests' own output goes).
//   {"s":"pass"|"fail"|"skip","t":"suite > test"}          a test
//   {"s":"fail","t":"suite","suite":true}                  a suite that failed (its body or a hook threw)
// Use with --test-isolation=none and one file per run, so names are the file's own test names. A file that fails to
// load is reported by node:test as a failing test named after the file.

import { openSync, writeSync } from 'node:fs';

const fd = process.env.CUPEL_REPORT ? openSync(process.env.CUPEL_REPORT, 'a') : null;

export default async function* reporter(source) {
  const names = [];
  for await (const event of source) {
    if (event.type === 'test:start') {
      names[event.data.nesting] = event.data.name;
      continue;
    }
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const d = event.data;
    const t = [...names.slice(0, d.nesting), d.name].join(' > ');
    const suite = d.details?.type === 'suite';
    let line;
    if (suite) {
      if (event.type !== 'test:fail') continue;
      line = { s: 'fail', t, suite: true };
    } else if (d.todo !== undefined && d.todo !== false) {
      line = { s: 'skip', t };
    } else if (event.type === 'test:fail') {
      line = { s: 'fail', t };
    } else {
      line = { s: d.skip !== undefined && d.skip !== false ? 'skip' : 'pass', t };
    }
    if (fd !== null) writeSync(fd, `${JSON.stringify(line)}\n`);
  }
}
