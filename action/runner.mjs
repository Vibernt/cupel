#!/usr/bin/env node
// Local M5 wrapper: no install, network call or upload.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { summary } from './summary.mjs';

const actionRoot = dirname(fileURLToPath(import.meta.url));
const cli = resolve(actionRoot, '../packages/cupel/bin/cupel.mjs');
const repo = process.cwd();

function git(args, maxBuffer = 1024 * 1024) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer });
  if (r.error || r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.error?.message ?? r.stderr.trim().slice(0, 200)}`);
  return r.stdout;
}

function trustedPath(value) {
  if (!value || isAbsolute(value) || value.includes('\\') || value.split('/').some((part) => !part || part === '.' || part === '..') || value.startsWith('-')) {
    throw new Error('approvals-path must be a repository-relative path without traversal');
  }
  return value;
}

function trustedBlob(base, path) {
  try { return git(['show', `${base}:${path}`]); }
  catch (error) { throw new Error(`trusted base lacks readable ${path}: ${error.message}`); }
}

function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Cupel Action requires Node 22 or newer');
  const base = process.env.CUPEL_BASE_COMMIT ?? '';
  if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(base)) throw new Error('base-commit must be a full 40- or 64-character Git commit id');
  const root = git(['rev-parse', '--show-toplevel']).trim();
  if (resolve(root) !== resolve(repo)) throw new Error('run the Action at the checked-out repository root');
  const actual = git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).trim();
  if (actual.toLowerCase() !== base.toLowerCase()) throw new Error('base-commit does not resolve to that exact commit');
  // Base material is outside the proposed tree; the head cannot replace guard rules or approvals.
  const config = trustedBlob(base, 'cupel.json');
  const approvalsPath = process.env.CUPEL_APPROVALS_PATH;
  const approvals = approvalsPath ? trustedBlob(base, trustedPath(approvalsPath)) : null;
  const temporary = mkdtempSync(join(tmpdir(), 'cupel-action-'));
  try {
    const configFile = join(temporary, 'cupel.json');
    writeFileSync(configFile, config, { mode: 0o600 });
    const args = [cli, 'guard', '--base', base, '--config', configFile, '--json', '--quiet'];
    if (approvals !== null) {
      const approvalsFile = join(temporary, 'approvals.json');
      writeFileSync(approvalsFile, approvals, { mode: 0o600 });
      args.push('--approvals', approvalsFile);
    }
    const env = { ...process.env };
    // Test-only overrides must not select a replacement collector or mutator in CI.
    delete env.NODE_ENV;
    for (const name of Object.keys(env)) if (name.startsWith('CUPEL_TEST_')) delete env[name];
    const run = spawnSync(process.execPath, args, { cwd: repo, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (run.error) throw new Error(`Cupel could not run: ${run.error.message}`);
    if (![0, 1, 2, 3].includes(run.status)) throw new Error(`Cupel exited unexpectedly: ${run.signal ?? run.status}`);
    // Keep the actual bounded error in the job log. A generic summary alone
    // would hide the collector/configuration cause needed to fix the failure.
    if (run.status >= 2 && run.stderr) process.stderr.write(run.stderr.slice(-4000));
    let report;
    try { report = JSON.parse(run.stdout); }
    catch {
      if (run.status === 0 || run.status === 1) throw new Error('Cupel did not return a JSON report');
      report = { diagnostics: [{ code: 'cli-error', message: `Cupel exited ${run.status} before producing a JSON report` }] };
    }
    const result = summary(report, run.status);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, result);
    process.stdout.write(result);
    return run.status;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

try { process.exitCode = main(); }
catch (error) {
  const message = String(error.message).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);
  const result = summary({ diagnostics: [{ code: 'action-error', message }] }, 3);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, result);
  process.stderr.write(`${message}\n`);
  process.exitCode = 3;
}
