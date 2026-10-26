import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globMatches } from '../../../packages/cupel/src/engine/match.mjs';
import { prepareNodeProfileBaseline } from '../../../packages/cupel/src/pr/prepare.mjs';
import { runNodeProfileRequest } from '../../../packages/cupel/src/pr/request.mjs';
import { assertExactGitBaseline } from '../../../packages/cupel/src/pr/git-identity.mjs';
import { nodeProfileProducerProof } from '../../../packages/cupel/src/pr/producer.mjs';
import { excludedTsx } from './derive-express.mjs';

const nodePath = '/opt/homebrew/Cellar/node/26.7.0/bin/node';
const pin = /^sha256:[0-9a-f]{64}$/;
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`,
  { flag: 'wx', mode: 0o600 });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const excluded = new Set(excludedTsx);

export function assertNoExcludedObservations(root) {
  let traceFiles = 0, rowsChecked = 0;
  const visit = dir => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('Express acceptance trace path is symlinked');
      if (stat.isDirectory()) { visit(path); continue; }
      if (name !== 'events.jsonl') continue;
      traceFiles++;
      for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
        const event = JSON.parse(line);
        rowsChecked++;
        for (const candidate of [event.file, event.path, event.target,
          event.detail?.file, event.detail?.path]) {
          if (typeof candidate !== 'string') continue;
          if ([...excluded].some(rel => candidate === rel || candidate.endsWith(`/${rel}`)))
            throw new Error('Express excluded TSX file appeared in a runtime observation');
        }
      }
    }
  };
  visit(root);
  return { traceFiles, rowsChecked, excludedEvents: 0 };
}

/** Run the complete, derived four-file lane with one externally supplied producer pin. */
export function runExpress(derivationPath, expectedProducerHash) {
  if (!pin.test(expectedProducerHash ?? ''))
    throw new Error('Express acceptance requires an external producer hash pin');
  const derivation = JSON.parse(readFileSync(resolve(derivationPath), 'utf8'));
  if (derivation.kind !== 's23-derived-express/1' ||
      !derivation.runDir.includes('/.scratch/s23/express-derived-') ||
      derivation.inputPolicy !== 'express-root-npmrc-opaque-v1' ||
      !same([...derivation.config?.scope?.exclude].sort(), [...excludedTsx].sort()) ||
      nodeProfileProducerProof().producerHash !== expectedProducerHash)
    throw new Error('Express derivation or producer differs from declared identity');
  const acceptanceDir = join(derivation.runDir, 'acceptance');
  mkdirSync(acceptanceDir);
  const summary = { kind: 's23-express-acceptance/1', derivationPath,
    derivedBaseCommit: derivation.baseCommit,
    originalCommit: derivation.originalCommit,
    originalOpaqueContentRead: false, inputPolicy: derivation.inputPolicy,
    expectedProducerHash, stage: 'prepare', baseline: null, cases: {} };
  try {
    const git = assertExactGitBaseline({ root: derivation.baseRoot,
      commit: derivation.baseCommit, inputPolicy: derivation.inputPolicy });
    if (excludedTsx.some(path => !Object.hasOwn(git.inputManifest, path)))
      throw new Error('Express exact TSX paths missing from complete safe input manifest');
    const pattern = derivation.config.runners.node.tests;
    const files = Object.keys(git.inputManifest).filter(file =>
      globMatches(pattern, file)).sort();
    if (files.length !== 4 || files.some(file => !file.startsWith('tests/unit/')))
      throw new Error(`Express full declared inventory differs: ${files.length} files`);
    const prepared = prepareNodeProfileBaseline({ root: derivation.baseRoot,
      baseCommit: derivation.baseCommit, files,
      out: join(acceptanceDir, 'prepare'),
      artifactPath: join(acceptanceDir, 'baseline.json'),
      config: derivation.config, nodePath, inputPolicy: derivation.inputPolicy,
      expectedProducerHash });
    const baseline = JSON.parse(readFileSync(prepared.artifact.path, 'utf8'));
    if (baseline.collection.input.tests.length !== 65 ||
        baseline.collection.fullFiles.length !== 4 ||
        baseline.reference.runRows.some(rows => rows.length !== 65))
      throw new Error('Express baseline did not retain all 65 rows and four files');
    if (excludedTsx.some(path => Object.hasOwn(baseline.collection.input.sources, path)))
      throw new Error('Express declared TSX exclusion was not honored in source analysis');
    for (const channels of Object.values(baseline.collection.observations))
      if (['imports', 'reads', 'probes'].some(key =>
          channels[key].some(path => excluded.has(path))))
        throw new Error('Express excluded TSX source appeared in baseline observations');
    summary.baseline = { artifact: prepared.artifact,
      files: baseline.collection.fullFiles, tests: baseline.collection.input.tests.length,
      safeManifestFiles: Object.keys(git.inputManifest).length,
      analyzedSources: Object.keys(baseline.collection.input.sources).length,
      excludedTsx: [...excludedTsx],
      criticalSites: baseline.critical.sites.length,
      referenceRows: baseline.reference.runRows.map(rows => rows.length),
      costs: prepared.costs };
    for (const [name, item] of Object.entries(derivation.cases)) {
      summary.stage = name;
      const result = runNodeProfileRequest({ root: item.root,
        baseCommit: derivation.baseCommit, baselinePath: prepared.artifact.path,
        expectedBaselineHash: prepared.artifact.sha256, expectedProducerHash,
        nodePath, out: join(acceptanceDir, name),
        resultPath: join(acceptanceDir, `${name}.json`),
        inputPolicy: derivation.inputPolicy });
      summary.cases[name] = { headCommit: item.headCommit,
        changedPath: item.changedPath,
        result: result.result, exit: result.exit,
        route: result.report.route,
        executedFiles: result.report.executedFiles,
        unexecutedFiles: result.report.unexecutedFiles,
        executedRows: result.report.comparison.tests.executed,
        failedTests: result.report.comparison.tests.failed,
        mutation: result.report.comparison.mutation,
        costs: result.report.costs };
    }
    summary.observations = assertNoExcludedObservations(acceptanceDir);
    summary.stage = 'complete';
  } catch (error) {
    summary.refusal = { stage: summary.stage, reason: error.message };
  }
  const summaryPath = join(acceptanceDir, 'acceptance.json');
  write(summaryPath, summary);
  return { summaryPath, ...summary };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runExpress(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(result));
  if (result.stage !== 'complete') process.exitCode = 3;
}
