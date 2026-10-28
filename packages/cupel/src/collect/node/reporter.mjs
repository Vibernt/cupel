// A node:test reporter for the collector: one JSON line per finished test or suite, nothing else.
//
// node:test reports each file's tests as one block, in order, and ends the block with a `test:summary` event
// whose `file` is the test file that ran (checked on Node 22 and 26). Events carry the file of the call site,
// which is a helper module when a helper defines the test, so records are held until the summary names the
// file. Full names join suite levels with ' > ', as TestContext.fullName does.
//
// Each line: { file, callFile, line, column, name, path, nesting, type, status, todo, ms, parent }
//   file      the test file that ran (absolute), callFile the call site's file
//   path      the names of the enclosing suites and tests, outermost first
//   type      'test' or 'suite'; status 'passed', 'failed' or 'skipped'
//   parent    true when other tests or suites ran inside this one

export default async function* reporter(source) {
  let stack = []; // per nesting level: { name, parent }
  let block = [];
  const flush = (file) => {
    const out = block.map((r) => `${JSON.stringify({ ...r, file: file ?? r.callFile })}\n`).join('');
    block = [];
    stack = [];
    return out;
  };
  for await (const { type, data } of source) {
    if (type === 'test:start') {
      stack.length = data.nesting;
      if (data.nesting > 0 && stack[data.nesting - 1]) stack[data.nesting - 1].parent = true;
      stack.push({ name: data.name, parent: false });
    } else if (type === 'test:pass' || type === 'test:fail') {
      if (stack[data.nesting]?.name !== data.name) {
        stack.length = data.nesting;
        stack.push({ name: data.name, parent: false });
      }
      const status = type === 'test:fail' ? 'failed' : data.skip !== undefined ? 'skipped' : 'passed';
      block.push({
        callFile: data.file ?? null,
        line: data.line ?? null,
        column: data.column ?? null,
        name: data.name,
        path: stack.slice(0, data.nesting).map((s) => s.name),
        nesting: data.nesting,
        type: data.details?.type === 'suite' ? 'suite' : 'test',
        status,
        todo: data.todo !== undefined,
        ms: data.details?.duration_ms ?? 0,
        parent: stack[data.nesting].parent,
      });
    } else if (type === 'test:summary' && data.file) {
      const out = flush(data.file);
      if (out) yield out;
      yield `${JSON.stringify({ type: 'summary', file: data.file, counts: data.counts })}\n`;
    }
  }
  if (block.length) yield flush(null);
}
