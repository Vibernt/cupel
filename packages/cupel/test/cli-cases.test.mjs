// Every conformance case through the CLI: `--json` prints exactly what run() returns, and the exit
// code is the case's expectExit. The human output exits the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/engine/index.mjs';

const BIN = fileURLToPath(new URL('../bin/cupel.mjs', import.meta.url));
const SPEC = fileURLToPath(new URL('../../../spec/', import.meta.url));
const CASES = `${SPEC}conformance/cases/`;
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const schemas = Object.fromEntries(['input', 'config', 'report'].map((n) => [n, read(`${SPEC}schemas/${n}.schema.json`)]));

// Run outside any git repository, so no cupel.json is picked up by accident.
const CWD = mkdtempSync(join(tmpdir(), 'cupel-cli-cases-'));
process.on('exit', () => rmSync(CWD, { recursive: true, force: true }));

/** The CLI arguments that give the engine this case's inputs, config and arguments. */
function cliArgs(dir, c) {
  const p = (f) => `${CASES}${dir}/${f}`;
  const args = [c.command];
  const hasBase = existsSync(p('base.json'));
  if (c.command === 'guard') args.push('--base-input', p('base.json'), '--head-input', p('head.json'));
  else if (hasBase) args.push('--base-input', p('base.json'), '--input', p('head.json'));
  else args.push('--input', p('input.json'));
  if (existsSync(p('config.json'))) args.push('--config', p('config.json'));
  const a = c.args ?? {};
  if (a.generatedAt !== undefined) args.push('--generated-at', a.generatedAt);
  if (a.changed !== undefined) {
    const f = join(CWD, `${dir}-changed.json`);
    writeFileSync(f, JSON.stringify(a.changed));
    args.push('--changed-lines', f);
  }
  if (a.approvals !== undefined) {
    const f = join(CWD, `${dir}-approvals.json`);
    writeFileSync(f, JSON.stringify(a.approvals));
    args.push('--approvals', f);
  }
  if (a.tests !== undefined) args.push(...a.tests);
  return args;
}

function engine(dir, c) {
  const p = (f) => `${CASES}${dir}/${f}`;
  const inputs = existsSync(p('base.json')) ? { base: read(p('base.json')), head: read(p('head.json')) } : { input: read(p('input.json')) };
  const config = existsSync(p('config.json')) ? read(p('config.json')) : {};
  return run(c.command, inputs, config, c.args ?? {}, schemas);
}

const cli = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: CWD, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

for (const dir of readdirSync(CASES).sort()) {
  test(`case ${dir} through the CLI`, () => {
    const c = read(`${CASES}${dir}/case.json`);
    const args = cliArgs(dir, c);
    const expected = engine(dir, c);

    const json = cli([...args, '--json']);
    assert.equal(json.stdout, `${JSON.stringify(expected.report, null, 2)}\n`, json.stderr);
    assert.equal(json.status, expected.exit);
    assert.equal(json.status, c.expectExit);

    const human = cli(args);
    assert.equal(human.status, c.expectExit, human.stderr);
    assert.ok(human.stdout.length > 0, 'human output is not empty');
    assert.doesNotMatch(human.stdout, /\x1b\[/, 'no colour when stdout is not a TTY');
  });
}
