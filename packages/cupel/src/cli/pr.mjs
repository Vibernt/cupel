// Explicit opt-in commands for the independently pinned Node selective profile.
import { resolve } from 'node:path';
import { globMatches } from '../engine/match.mjs';
import { assertExactGitBaseline } from '../pr/git-identity.mjs';
import { nodeProfileProducerProof } from '../pr/producer.mjs';
import { prepareNodeProfileBaseline } from '../pr/prepare.mjs';
import { runNodeProfileRequest } from '../pr/request.mjs';
import { projectRoot, loadConfig } from './context.mjs';
import { usage, environment, CliError } from './errors.mjs';

const PROFILE = 'node-readonly-files-v2';
const PIN = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function required(options, name, pattern) {
  const value = options[name];
  if (typeof value !== 'string' || !value || pattern && !pattern.test(value))
    throw usage(`--${name} ${pattern ? 'requires an exact valid value' : 'is required'}`);
  return value;
}

function emit(io, options, report, exit, line) {
  io.result?.({ exit, report });
  io.out(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${line}\n`);
  return exit;
}

export function prCommand(command, options, io) {
  if (command === 'pr-producer') {
    if (options.config) throw usage('pr-producer does not read project configuration');
    const proof = nodeProfileProducerProof();
    return emit(io, options, proof, 0,
      `${PROFILE} producer ${proof.producerHash}\nRecord this pin in trusted storage before preparing or executing a PR.`);
  }
  if (required(options, 'profile') !== PROFILE)
    throw usage(`supported selective profile: ${PROFILE} (Node 26.7.0 only)`);
  const baseCommit = required(options, 'base', COMMIT);
  const expectedProducerHash = required(options, 'producer-sha256', PIN);
  const inputPolicy = options['input-policy'] ?? 'strict-v1';
  if (!['strict-v1', 'express-root-npmrc-opaque-v1'].includes(inputPolicy))
    throw usage('--input-policy must be strict-v1 or express-root-npmrc-opaque-v1');
  const out = resolve(io.cwd, required(options, 'work-dir'));
  const outputPath = resolve(io.cwd, required(options, 'out'));
  const root = projectRoot(io.cwd);
  const nodePath = options.node === undefined ? process.execPath : resolve(io.cwd, options.node);
  if (command === 'pr' && options.config)
    throw usage('pr uses the sealed baseline configuration; --config is not accepted');
  const baselinePath = command === 'pr' ? resolve(io.cwd, required(options, 'baseline')) : null;
  const expectedBaselineHash = command === 'pr' ? required(options, 'baseline-sha256', PIN) : null;
  try {
    if (command === 'pr-prepare') {
      const config = loadConfig(root, io.cwd, options.config);
      const git = assertExactGitBaseline({ root, commit: baseCommit, inputPolicy });
      const pattern = config.runners?.node?.tests ?? 'tests/**/*.test.mjs';
      const files = Object.keys(git.inputManifest).filter(file =>
        TEST_FILE.test(file) && globMatches(pattern, file)).sort();
      const prepared = prepareNodeProfileBaseline({ root, baseCommit, files, out,
        artifactPath: outputPath, config, nodePath, expectedProducerHash, inputPolicy });
      return emit(io, options, prepared, 0,
        `Prepared ${PROFILE} baseline: ${prepared.artifact.path}\nBaseline pin: ${prepared.artifact.sha256}\nPreparation: ${prepared.costs.totalMs} ms; store the artifact and pin outside the proposing agent's write scope.`);
    }
    const value = runNodeProfileRequest({ root, baseCommit, baselinePath,
      expectedBaselineHash, expectedProducerHash, nodePath, out, resultPath: outputPath, inputPolicy });
    return emit(io, options, value.report, value.exit,
      `Scoped PR ${value.exit === 0 ? 'passed' : 'failed'} (${value.report.route}); ${value.report.executedFiles.length} files executed, ${value.report.unexecutedFiles.length} unexecuted; ${value.report.costs.requestMs} ms.\nWhole-suite guard pass: false. Result: ${value.result.path}`);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw environment(`selective profile refused: ${error.message}`);
  }
}
