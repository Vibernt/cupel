import { isAbsolute, relative, sep } from 'node:path';

const rel = (root, file) => {
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('Node result lacks an absolute call file');
  const path = relative(root, file).split(sep).join('/');
  if (!path || path === '..' || path.startsWith('../')) throw new Error('Node result call file escapes subject root');
  return path;
};

export function resultRows(stdout, root, file) {
  let events;
  try { events = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { throw new Error(`malformed Node result stream: ${error.message}`); }
  if (!events.some(event => event.type === 'test:plan')) throw new Error('missing Node test plan');
  const names = new Map();
  const starts = new Map();
  const failedParents = new Set();
  const rows = [];
  for (const event of events) {
    if (event.type === 'test:start') {
      if (!Number.isSafeInteger(event.data.testId) || starts.has(event.data.testId))
        throw new Error('duplicate or missing Node test start identity');
      starts.set(event.data.testId, { name: event.data.name, parentId: event.data.parentId });
      continue;
    }
    if (!['test:pass', 'test:fail'].includes(event.type) || event.data.details?.type === 'suite') continue;
    if (event.type === 'test:fail') failedParents.add(event.data.testId);
    if ([...starts.values()].some(start => start.parentId === event.data.testId)) continue;
    const self = starts.get(event.data.testId);
    if (!self || self.name !== event.data.name || self.parentId !== event.data.parentId)
      throw new Error('Node test completion differs from its start identity');
    const path = rel(root, event.data.entryFile ?? event.data.file);
    if (path !== file) throw new Error(`foreign or missing Node test file: ${path}`);
    const ancestor = [];
    const ancestorIds = [];
    let parentId = event.data.parentId;
    while (parentId) {
      const parent = starts.get(parentId);
      if (!parent) throw new Error(`Node test parent ${parentId} did not start`);
      ancestor.unshift(parent.name);
      ancestorIds.unshift(parentId);
      parentId = parent.parentId;
      if (ancestor.length > starts.size) throw new Error('cyclic Node test ancestry');
    }
    const fullName = [...ancestor, event.data.name].join(' > ');
    const key = `${path}\0${fullName}`;
    const ordinal = (names.get(key) ?? 0) + 1;
    names.set(key, ordinal);
    const callFile = rel(root, event.data.file);
    if (!Number.isSafeInteger(event.data.line) || event.data.line < 1 ||
        !Number.isSafeInteger(event.data.column) || event.data.column < 1 ||
        !Number.isFinite(event.data.details?.duration_ms) || event.data.details.duration_ms < 0)
      throw new Error('Node result lacks definition or duration evidence');
    rows.push({ file: path, id: `${fullName}#${ordinal}`, fullName, ordinal,
      canonicalId: `${path}::${fullName}${ordinal > 1 ? ` #${ordinal}` : ''}`,
      name: fullName, leaf: event.data.name, path: ancestor, callFile,
      line: event.data.line, column: event.data.column, ms: event.data.details.duration_ms,
      ancestorIds,
      status: event.data.skip !== undefined || event.data.todo !== undefined ? 'skipped' :
        event.type === 'test:fail' ? 'failed' : 'passed' });
  }
  if (!rows.length) throw new Error('no Node test rows');
  for (const row of rows) {
    if (row.status === 'passed' && row.ancestorIds.some(id => failedParents.has(id))) row.status = 'failed';
    delete row.ancestorIds;
  }
  return rows;
}
