import { bucket, recorder } from '../assertions/recorder.mjs';
import { installVitestAssertions } from '../assertions/vitest.mjs';
// Loaded in each Vitest fork. The inspector session never opens a listening port.
import { Session } from 'node:inspector';
import { writeFileSync } from 'node:fs';
import { writeAtomicJson } from '../atomic-json.mjs';
import { createHash } from 'node:crypto';
import { positiveIntervals, unionIntervals } from '../node/intervals.mjs';
import { watchInterpreters } from './interpreters.mjs';

const cfg = JSON.parse(process.env.CUPEL_VITEST_HOOK);
const vitest = await import(process.env.CUPEL_VITEST_IMPORT);
const session = new Session();
session.connect();
const post = (method, params = {}) => {
  let done = false, result, error;
  session.post(method, params, (e, r) => { done = true; error = e; result = r; });
  if (!done) throw new Error(`${method} did not answer synchronously`);
  if (error) throw error;
  return result;
};
post('Debugger.enable');
post('Profiler.enable');
post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });

const scripts = new Map();
const tests = new Map();
const setup = new Map();
const active = new Set();
const failures = [];
if (cfg.assertions) installVitestAssertions(vitest, recorder(cfg.root, () => [...active].map((id) => tests.get(id).assertions), cfg.assertionCap));
let currentFile = null;
watchInterpreters(() => { for (const id of active) tests.get(id).spawnsInterpreter = true; });
const take = () => {
  const owners = [...active];
  for (const sc of post('Profiler.takePreciseCoverage').result) {
    if (!sc.url.includes(cfg.root)) continue;
    const intervals = positiveIntervals(sc.functions);
    if (!intervals.length) continue;
    if (!scripts.has(sc.scriptId)) {
      try { scripts.set(sc.scriptId, { url: sc.url, source: post('Debugger.getScriptSource', { scriptId: sc.scriptId }).scriptSource }); }
      catch (e) { failures.push(`${sc.url}: ${e.message}`); continue; }
    }
    for (const target of owners.length ? owners.map((id) => tests.get(id).coverage) : [setup]) {
      target.set(sc.scriptId, unionIntervals(target.get(sc.scriptId), intervals));
    }
  }
};

vitest.beforeEach((context) => {
  currentFile = context.task.file?.filepath;
  if (!currentFile) throw new Error('Vitest task did not provide its file path');
  take();
  const id = context.task.id;
  tests.set(id, { coverage: new Map(), spawnsInterpreter: false, ...(cfg.assertions ? { assertions: bucket() } : {}) });
  active.add(id);
});
vitest.afterEach((context) => {
  const id = context.task.id;
  vitest.onTestFinished(() => { take(); active.delete(id); });
});
const flush = () => {
  try {
    take();
    const entries = (map) => Object.fromEntries(map);
    const fileId = currentFile ? createHash('sha256').update(currentFile).digest('hex').slice(0, 16) : 'unknown';
    writeAtomicJson(`${cfg.out}/${process.pid}-${fileId}.json`, { file: currentFile,
      scripts: entries(scripts), setup: entries(setup),
      tests: Object.fromEntries([...tests].map(([id, t]) => [id, { coverage: entries(t.coverage), spawnsInterpreter: t.spawnsInterpreter, ...(cfg.assertions ? { assertions: t.assertions } : {}) }])),
      failures,
    });
  } catch (e) {
    writeFileSync(`${cfg.out}/${process.pid}.error`, String(e.stack ?? e));
  }
};
vitest.afterAll(() => { take(); flush(); });
process.on('exit', flush);
