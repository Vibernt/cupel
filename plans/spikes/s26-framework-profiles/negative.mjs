// Current Node-profile capability denials, with scratch-only representative subjects.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const profile = join(repo, 'packages/cupel/src/pr/profiles/node');
const scratch = join(repo, '.scratch/s26-framework-profiles');
mkdirSync(scratch, { recursive: true });
const subjects = [
  ['jest-vm', "const vm = require('node:vm'); vm.compileFunction('return 1')();\n"],
  ['vitest-fork', "const cp = require('node:child_process'); cp.fork(__filename, [], {env:{...process.env, CUPEL_S26_CHILD:'1'}});\n"],
  ['vitest-worker', "const wt = require('node:worker_threads'); new wt.Worker('1', {eval:true});\n"],
  ['vite-dynamic-compiler', "const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor; new AsyncFunction('return 1');\n"],
];
const nodes = [process.execPath, '/opt/homebrew/opt/node@22/bin/node'];
const results = [];
for (const [name, code] of subjects) {
  const root = mkdtempSync(join(scratch, `negative-${name}-`));
  writeFileSync(join(root, 'subject.test.cjs'),
    "if (process.env.CUPEL_S26_CHILD) process.exit(0);\nconst {test}=require('node:test');\n" +
    `test('representative', () => { ${code} });\n`);
  for (const node of nodes) {
    const version = node.includes('node@22') ? '22.23.3' : '26.7.0';
    const tmp = join(root, `private-${version}`);
    mkdirSync(tmp);
    const env = { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp, CI: '1', NO_COLOR: '1', TZ: 'UTC', LANG: 'C',
      CUPEL_ROOT: root, CUPEL_PRIVATE_TMP: tmp, CUPEL_OWNER: 'subject.test.cjs', CUPEL_INPUT_POLICY: 'strict-v1',
      CUPEL_INPUTS: JSON.stringify(['subject.test.cjs']), CUPEL_LOCKED_PACKAGES: '[]',
      CUPEL_PROFILE_COVERAGE: 'per-test-v1', CUPEL_INPUT_MANIFEST_HASH: 'sha256:' + '0'.repeat(64) };
    const child = spawnSync(node, ['--permission', '--allow-inspector', '--disable-sigusr1',
      `--allow-fs-read=${root}`, `--allow-fs-read=${profile}`,
      `--allow-fs-read=${tmp}`, `--allow-fs-write=${tmp}`, `--require=${join(profile, 'bootstrap.cjs')}`,
      '--test', '--experimental-test-isolation=none', 'subject.test.cjs'],
    { cwd: root, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1 << 20 });
    const eventsPath = join(tmp, 'events.jsonl');
    const events = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const denials = events.filter(event => event.kind === 'unsupported').map(event => event.reason);
    const row = { name, node: version, root, exit: child.status, signal: child.signal,
      denials, outputTail: `${child.stdout ?? ''}\n${child.stderr ?? ''}`.slice(-500) };
    writeFileSync(join(tmp, 'run.out'), `${child.stdout ?? ''}\n${child.stderr ?? ''}`);
    results.push(row);
  }
}
writeFileSync(join(scratch, 'negative-summary.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.map(({ name, node, exit, signal, denials }) => ({ name, node, exit, signal, denials }))));
for (const row of results) {
  const expected = row.name === 'vite-dynamic-compiler' ? 'forbidden-Function' : 'forbidden-module';
  if (row.node === '26.7.0' && (row.exit === 0 || !row.denials.includes(expected)))
    throw new Error(`Node 26 profile did not deny ${row.name} as expected`);
  if (row.node === '22.23.3' && !row.outputTail.includes('bad option: --allow-inspector'))
    throw new Error(`Node 22 profile startup state changed for ${row.name}`);
}
