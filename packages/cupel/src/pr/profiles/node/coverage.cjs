const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const inspector = require('node:inspector');
require('node:inspector/promises');
const { before, beforeEach, afterEach, after } = require('node:test');
const { root, tmp, owner, emit } = require('./policy.cjs');
const { positiveIntervals, unionIntervals, addAll } = require('./intervals.cjs');

if (process.env.CUPEL_PROFILE_COVERAGE !== 'per-test-v1')
  throw new Error('Node v2 requires per-test coverage at bootstrap');
const declared = new Set(JSON.parse(process.env.CUPEL_INPUTS));
const inputManifestHash = process.env.CUPEL_INPUT_MANIFEST_HASH;
const sources = new Set([...declared].filter(name =>
  /\.(?:[cm]?js|ts|mts|cts)$/.test(name) && !/(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]s$/.test(name)));
const session = new inspector.Session();
const connect = session.connect.bind(session);
const postOriginal = session.post.bind(session);
const disconnect = session.disconnect.bind(session);
const errors = [], tests = [], active = new Set(), seen = new Map(), setup = new Map();
const boundaries = { before: 0, beforeEach: 0, afterEach: 0, after: 0, exit: 0, checkpoints: 0 };
const bad = (stage, error) => {
  const detail = `${stage}:${String(error?.message ?? error).split('\n')[0]}`;
  errors.push(detail);
  emit({ kind: 'coverage-error', channel: 'control', detail });
  return new Error(`Node v2 coverage incomplete: ${detail}`);
};
const post = (method, params = {}) => {
  let answered = false, failure, result;
  postOriginal(method, params, (error, value) => { answered = true; failure = error; result = value; });
  if (!answered || failure) throw bad(method, failure ?? 'inspector response was not synchronous');
  return result;
};
try { connect(); post('Profiler.enable'); post('Profiler.startPreciseCoverage',
  { callCount: true, detailed: true }); }
catch (error) { throw bad('connect/start', error); }

const relOf = url => {
  if (!url?.startsWith('file:')) return null;
  let relative;
  try { relative = path.relative(root, fileURLToPath(url.replace(/[?#].*$/, ''))).split(path.sep).join('/'); }
  catch { return null; }
  return sources.has(relative) ? relative : null;
};
const leaves = () => {
  const all = [...active];
  return all.length < 2 ? all : all.filter(test => !all.some(other =>
    other !== test && other.fullName.startsWith(`${test.fullName} > `)));
};
const checkpoint = stage => {
  let result;
  try { result = post('Profiler.takePreciseCoverage').result; }
  catch (error) { throw bad(stage, error); }
  if (!Array.isArray(result)) throw bad(stage, 'missing V8 coverage result');
  boundaries.checkpoints++;
  const got = new Map();
  try {
    for (const script of result) {
      const source = relOf(script.url);
      if (!source) continue;
      const intervals = positiveIntervals(script.functions);
      if (intervals.length) got.set(source, unionIntervals(got.get(source), intervals));
    }
  } catch (error) { throw bad(`${stage}-mapping`, error); }
  if (!got.size) return;
  const owners = leaves();
  if (!owners.length) addAll(setup, got);
  else for (const test of owners) addAll(test.cov, got);
};

before(() => { boundaries.before++; checkpoint('before'); });
beforeEach(test => {
  checkpoint('beforeEach'); boundaries.beforeEach++;
  const fullName = test.fullName ?? test.name;
  const ordinal = seen.get(fullName) ?? 0;
  seen.set(fullName, ordinal + 1);
  const row = { fullName, ordinal, cov: new Map(), context: test, completed: false };
  tests.push(row); active.add(row);
});
afterEach(test => {
  test.after(() => {
    checkpoint('afterEach'); boundaries.afterEach++;
    const row = [...active].find(item => item.context === test);
    if (!row) throw bad('afterEach', 'active test context missing');
    active.delete(row); row.completed = true; row.context = null;
  });
});
after(() => { boundaries.after++; checkpoint('after'); });
process.on('exit', () => {
  try { checkpoint('exit'); boundaries.exit++; }
  catch (error) { if (!errors.length) bad('exit', error); }
  try { post('Profiler.stopPreciseCoverage'); post('Profiler.disable'); disconnect(); }
  catch (error) { bad('stop/disconnect', error); }
  if (active.size || tests.some(row => !row.completed) || boundaries.before !== 1 || boundaries.after !== 1)
    bad('completion', 'test boundaries did not finish');
  const record = { version: 'cupel-node-coverage/1', owner,
    inputManifestHash,
    boundaries, errors,
    setup: Object.fromEntries(setup),
    tests: tests.map(row => ({ fullName: row.fullName, ordinal: row.ordinal,
      completed: row.completed, cov: Object.fromEntries(row.cov) })) };
  try { fs.writeFileSync(path.join(tmp, 'coverage.json'), JSON.stringify(record)); }
  catch (error) { bad('serialize', error); }
});
