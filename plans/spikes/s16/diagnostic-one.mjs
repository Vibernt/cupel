import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadSealed, saveJson } from './artifacts.mjs';
import { cases, files } from './fixture.mjs';
import { cohesiveSelected, guardedFull, oldSelected, verifyMethod } from './methods.mjs';
import { assertFullCapture } from './oracle.mjs';

const [runDir, caseName, method] = process.argv.slice(2);
const item = cases.find(entry => entry.name === caseName);
const methods = { old: oldSelected, candidate: cohesiveSelected, full: guardedFull };
if (!runDir || !item || !Object.hasOwn(methods, method) || !globalThis.__s16Diagnostic)
  throw new Error('S16 diagnostic requires sealed run, case, method and preload');

const saved = loadSealed(runDir);
const validity = saved['validity.json'];
const fullRows = assertFullCapture(saved[`${item.name}-full.json`],
  files, item.failures, `${item.name} diagnostic full oracle`);
const label = `diagnostic-${caseName}-${method}`;
const out = join(runDir, `${label}-work`);
globalThis.__s16Diagnostic.reset();
const result = methods[method]({ bundle: saved['bundle.json'], baselineArgs: saved['args.json'],
  caseName, nodePath: process.execPath, out });
globalThis.__s16Diagnostic.freeze();
const proof = verifyMethod(result, caseName, fullRows);
if (method === 'candidate' &&
  result.capture.sidecar.execution.profileRuntimeHash !==
    validity.cases[caseName].candidateProducerHash)
  throw new Error('S16 diagnostic candidate producer differs from validity');
const traces = method === 'full' ? [join(out, 'opaque-full-trace.jsonl')] :
  result.decision.files.map(file => join(out, file.replaceAll('/', '_'), 'events.jsonl'));
if (traces.some(path => !existsSync(path))) throw new Error('S16 diagnostic trace missing');
const traceBytes = traces.reduce((sum, path) => sum + statSync(path).size, 0);
saveJson(runDir, `${label}.json`, { method, caseName, result, proof, traceBytes });
process.stdout.write(`${JSON.stringify({ caseName, method, wallMs: result.wallMs,
  traceBytes, selectedFiles: result.decision?.files?.length ?? files.length })}\n`);
