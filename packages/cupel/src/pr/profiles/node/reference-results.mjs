import {isAbsolute, relative, sep} from 'node:path';

const tagPattern = /\[(critical|standard|minor)\]/g;
const inside = (root, file) => {
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('reference result lacks absolute file');
  const rel = relative(root, file).split(sep).join('/');
  if (!rel || rel === '..' || rel.startsWith('../')) throw new Error('reference result file escapes root');
  return rel;
};

/** Parse the normal runner's reporter stream independently of v2 coverage. */
export function referenceRows(stdout, root, expectedFiles) {
  const starts = new Map(), completions = new Map(), events = [];
  for (const line of stdout.split('\n').filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error('malformed reference reporter stream'); }
    if (!event || typeof event.type !== 'string' || !event.data)
      throw new Error('malformed reference reporter event');
    events.push(event);
  }
  if (!events.some(event => event.type === 'test:plan')) throw new Error('missing reference test plan');
  const plans = events.filter(event => event.type === 'test:plan');
  const rootPlans = plans.filter(event => event.data.nesting === 0);
  if (rootPlans.length !== 1) throw new Error('duplicate or missing reference root test plan');
  for (const event of events) {
    const data = event.data;
    if (!['test:start','test:pass','test:fail'].includes(event.type)) continue;
    const owner = inside(root, data.entryFile ?? data.file);
    if (!expectedFiles.has(owner)) throw new Error(`foreign reference event owner: ${owner}`);
    const key = `${owner}\0${data.testId}`;
    if (event.type === 'test:start') {
      if (!Number.isSafeInteger(data.testId) || starts.has(key) ||
          typeof data.name !== 'string' || !data.name)
        throw new Error('duplicate or malformed reference test start');
      starts.set(key, {name:data.name,parentId:data.parentId});
    }
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      if (!Number.isSafeInteger(data.testId) || completions.has(key))
        throw new Error('duplicate or malformed reference completion');
      const start = starts.get(key);
      if (!start || start.name !== data.name || start.parentId !== data.parentId)
        throw new Error('reference completion differs from start');
      completions.set(key, event);
    }
  }
  if (!starts.size || starts.size !== completions.size)
    throw new Error('missing reference test completion');
  if (!Number.isSafeInteger(rootPlans[0].data.count) ||
      rootPlans[0].data.count !== [...starts.values()].filter(start => !start.parentId).length)
    throw new Error('reference test plan differs from completed roots');
  const rows = [], ordinals = new Map(), owners = new Set();
  for (const [eventKey, event] of completions) {
    const data = event.data;
    if (!data.entryFile) throw new Error('reference result lacks subject entry file');
    const file = inside(root, data.entryFile);
    const id = data.testId;
    if ([...starts.entries()].some(([key,start]) =>
        key.startsWith(`${file}\0`) && start.parentId === id)) continue;
    if (data.details?.type === 'suite') continue;
    owners.add(file);
    const ancestors = [];
    let parent = data.parentId;
    while (parent) {
      const value = starts.get(`${file}\0${parent}`);
      if (!value) throw new Error('missing reference parent');
      ancestors.unshift(value.name);
      parent = value.parentId;
      if (ancestors.length > starts.size) throw new Error('cyclic reference parent');
    }
    const name = [...ancestors, data.name].join(' > ');
    const key = `${file}::${name}`;
    const ordinal = (ordinals.get(key) ?? 0) + 1;
    ordinals.set(key, ordinal);
    const callFile = inside(root, data.file);
    if (!Number.isSafeInteger(data.line) || data.line < 1 ||
        !Number.isSafeInteger(data.column) || data.column < 1 ||
        !Number.isFinite(data.details?.duration_ms))
      throw new Error('reference result lacks call site or duration proof');
    const failedParent = (() => {
      let next = data.parentId;
      while (next) {
        if (completions.get(`${file}\0${next}`)?.type === 'test:fail') return true;
        next = starts.get(`${file}\0${next}`)?.parentId;
      }
      return false;
    })();
    rows.push({id:`${key}${ordinal > 1 ? ` #${ordinal}` : ''}`,file,name,
      status:data.skip !== undefined || data.todo !== undefined ? 'skipped' :
        event.type === 'test:fail' || failedParent ? 'failed' : 'passed',
      tags:[...new Set([...name.matchAll(tagPattern)].map(match => match[1]))].sort()});
  }
  if (!rows.length || owners.size !== expectedFiles.size ||
      [...expectedFiles].some(file => !owners.has(file)))
    throw new Error('reference result missing expected test file');
  rows.sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (rows.some((row,index) => index && rows[index-1].id === row.id))
    throw new Error('duplicate reference canonical identity');
  return rows;
}
