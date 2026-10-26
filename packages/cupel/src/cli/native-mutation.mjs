import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { environment } from './errors.mjs';

const quote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;

function actionCommand(collector, action) {
  if (typeof collector !== 'string' || !/\scollect\s*$/.test(collector))
    throw environment('Ruby collector command must end in collect to derive mutate or confirm');
  return `${collector.replace(/\scollect\s*$/, '')} ${action}`;
}

/** Run the configured Ruby collector's exact command prefix as mutate/confirm. */
export function mutateRuby({ runner, root, cfg, input, scope, mutation, ids = [] }) {
  if (!runner || runner.name !== 'minitest') throw environment('Ruby mutation needs a minitest collector');
  const action = mutation ? 'confirm' : 'mutate';
  if (!mutation && (!scope || typeof scope !== 'object' || Array.isArray(scope)))
    throw environment('Ruby mutation needs an object scope');
  if (!mutation && scope.changed != null &&
      (typeof scope.changed !== 'object' || Array.isArray(scope.changed)))
    throw environment('Ruby mutation changed-line scope must be an object');
  const command = actionCommand(runner.collector, action);
  const scratch = join(root, '.scratch');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'cupel-rubymut-cli-'));
  try {
    const inputFile = join(dir, 'input.json');
    const configFile = join(dir, 'config.json');
    const scopeFile = join(dir, 'scope.json');
    const mutationFile = join(dir, 'mutation.json');
    const output = join(dir, 'output.json');
    writeFileSync(inputFile, JSON.stringify(input));
    writeFileSync(configFile, JSON.stringify(cfg));
    if (!mutation) writeFileSync(scopeFile, JSON.stringify({ ...scope, changed: scope.changed ?? {} }));
    if (mutation) writeFileSync(mutationFile, JSON.stringify(mutation));
    const args = mutation
      ? `--input ${quote(inputFile)} --mutation ${quote(mutationFile)} --ids ${quote(ids.join(','))}`
      : `--input ${quote(inputFile)} --scope ${quote(scopeFile)}`;
    const env = { ...process.env, ...(runner.env ?? {}), TMPDIR: dir, XDG_CACHE_HOME: dir };
    const child = spawnSync(`${command} --root ${quote(root)} --config ${quote(configFile)} ${args} --out ${quote(output)}`, {
      cwd: root, env, shell: true, encoding: 'utf8', maxBuffer: 1 << 28,
    });
    if (child.error || child.status !== 0)
      throw environment(`Ruby mutation ${action} failed (${child.error?.message ?? `exit ${child.status}`}): ${(child.stderr || child.stdout || '').trim().slice(-500)}`);
    if (!existsSync(output)) throw environment(`Ruby mutation ${action} did not write --out file`);
    let value;
    try { value = JSON.parse(readFileSync(output, 'utf8')); }
    catch (error) { throw environment(`Ruby mutation ${action} output is not JSON: ${error.message}`); }
    if (!value || !Array.isArray(value.mutants) || !Array.isArray(value.targeted))
      throw environment(`Ruby mutation ${action} did not return a standalone mutation object`);
    return value;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
