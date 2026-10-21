// S2 node:test reporter: one JSON line per finished test (pass, fail, skip, todo), nothing else.
//
// Usage:
//   node --test --test-reporter=./plans/spikes/s2/reporter.mjs --test-reporter-destination=out.ndjson tests/x.test.mjs
//   node --test-reporter=<abs path>/reporter.mjs --test-reporter-destination=out.ndjson tests/x.test.mjs
//
// Each line: { "event": "pass"|"fail", "name", "nesting", "file", "ms", "skip", "todo", "type" }.
// The S2 drivers use it to list a file's tests and to check that a per-test run ran exactly one test.

export default async function* reporter(source) {
  for await (const { type, data } of source) {
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    yield `${JSON.stringify({
      event: type === 'test:pass' ? 'pass' : 'fail',
      name: data.name,
      nesting: data.nesting,
      file: data.file,
      ms: data.details?.duration_ms,
      type: data.details?.type,
      skip: data.skip !== undefined,
      todo: data.todo !== undefined,
    })}\n`;
  }
}
