#!/usr/bin/env node
// S8 A/B harness. `prepare` creates isolated Assay repos; this script never starts agent arms.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNode } from '../../../packages/cupel/src/collect/node/index.mjs';
import { mutateNode, generateMutants } from '../../../packages/cupel/src/mutate/index.mjs';
import { checked, definitionsFromDiff, lineCount, matchIds, run, shQuote, usageFromLog } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cupelRoot = resolve(here, '../../..');
const assay = '/Users/vid/cupel/.scratch/assay-base';
const experiments = '/Users/vid/cupel/.scratch/s8';
const node = '/opt/homebrew/bin/node';
const cupel = join(cupelRoot, 'packages/cupel/bin/cupel.mjs');
const tasks = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'));
const s3 = JSON.parse(readFileSync(join(here, '../s3/summary.json'), 'utf8')).survivors;
const s3Annotations = JSON.parse(readFileSync(join(here, '../s3/survivors.json'), 'utf8'));
const baseline = checked('git', ['-C', assay, 'rev-parse', 'assay-main']).trim();
if (baseline !== '5a5a13133c9e6dfb323b49a340051e955cd9edeb') throw new Error(`Assay assay-main moved to ${baseline}`);

function taskById(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error(`unknown task ${id}; choose ${tasks.map((t) => t.id).join(', ')}`);
  return task;
}

function armDir(taskId, arm, rep) {
  if (!['plain', 'cupel'].includes(arm)) throw new Error(`unknown arm ${arm}`);
  if (!/^[1-9][0-9]*$/.test(rep)) throw new Error('rep must be a positive integer');
  return join(experiments, `${taskId}-${arm}-${rep}`);
}

function agentPrompt(task, arm) {
  const shared = `${task.prompt}\nAdd tests only, in tests/*.test.mjs. Do not change src/. Do not use the network or install dependencies. Run the tests you add and report what they prove.\n`;
  return arm === 'cupel'
    ? `${shared}Before you finish, call the \`cupel_check\` MCP tool on every test you added, and keep only tests it says add value, unless you can justify one in a comment.\n`
    : shared;
}

function commandFile(dir, arm) {
  const args = ['codex', 'exec', '-C', shQuote(dir)];
  if (arm === 'cupel') {
    args.push('-c', shQuote('mcp_servers.cupel.command="/opt/homebrew/bin/node"'));
    args.push('-c', shQuote(`mcp_servers.cupel.args=["/Users/vid/cupel/packages/cupel/bin/cupel.mjs","mcp","--root","${dir}"]`));
  }
  args.push('--approve-for-me', '--json', '-');
  const line = args.join(' ');
  return `#!/bin/sh\nset -u\ncd ${shQuote(dir)}\nstart=$(${shQuote(node)} -p 'Date.now()')\n${line} < prompt.md > codex.jsonl 2> codex.stderr\nstatus=$?\nend=$(${shQuote(node)} -p 'Date.now()')\nprintf '{"startedMs":%s,"endedMs":%s,"exit":%s}\\n' "$start" "$end" "$status" > arm-timing.json\nexit "$status"\n`;
}

function prepare(taskId, arm, rep) {
  const task = taskById(taskId);
  const dir = armDir(taskId, arm, rep);
  if (existsSync(dir)) throw new Error(`arm already exists: ${dir}`);
  mkdirSync(dir, { recursive: true });
  const archive = run('bash', ['-o', 'pipefail', '-c', `git -C '${assay}' archive '${baseline}' | tar -x -C '${dir}'`]);
  if (archive.status !== 0) throw new Error(`archive failed: ${archive.stderr.trim()}`);
  checked(node, ['scripts/generate.mjs', '--build'], { cwd: dir });
  writeFileSync(join(dir, 'cupel.json'), `${JSON.stringify({ runners: { node: { tests: 'tests/*.test.mjs' } } }, null, 2)}\n`);
  checked('git', ['init', '-q'], { cwd: dir });
  checked('git', ['add', '-A'], { cwd: dir });
  checked('git', ['-c', 'user.name=S8 Harness', '-c', 'user.email=s8@invalid.local', 'commit', '-qm', 'S8 Assay baseline'], { cwd: dir });
  writeFileSync(join(dir, '.s8.json'), `${JSON.stringify({ taskId, arm, rep: Number(rep), module: task.module, assayCommit: baseline }, null, 2)}\n`);
  writeFileSync(join(dir, 'prompt.md'), agentPrompt(task, arm));
  writeFileSync(join(dir, 'command.sh'), commandFile(dir, arm), { mode: 0o755 });
  return { dir, taskId, arm, rep: Number(rep), baseline, command: join(dir, 'command.sh') };
}

function newDefinitions(dir) {
  const diff = checked('git', ['diff', '--unified=0', 'HEAD', '--', 'tests'], { cwd: dir });
  const defs = definitionsFromDiff(diff);
  const untracked = checked('git', ['ls-files', '--others', '--exclude-standard', '--', 'tests'], { cwd: dir }).trim().split('\n').filter((p) => /\.test\.mjs$/.test(p));
  for (const file of untracked) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      const found = definitionsFromDiff(`+++ b/${file}\n+${line}`);
      defs.push(...found);
    }
  }
  const numstat = checked('git', ['diff', '--numstat', 'HEAD', '--', 'tests'], { cwd: dir });
  let addedLines = numstat.trim().split('\n').filter(Boolean).reduce((n, line) => n + (Number(line.split('\t')[0]) || 0), 0);
  for (const file of untracked) addedLines += lineCount(readFileSync(join(dir, file), 'utf8'));
  return { definitions: defs, addedLines };
}

function s3Matches(dir, module, mutation, newIds) {
  const generated = generateMutants(module, readFileSync(join(dir, module), 'utf8'));
  const byId = new Map(mutation.mutants.map((m) => [m.id, m]));
  const newSet = new Set(newIds);
  return s3.filter((s) => s.file === module).map((s) => {
    const col = Number(s.id.split(':')[2]);
    const candidates = generated.filter((m) => m.line === s.line && m.col === col && m.operator === s.op && m.original === s.original);
    const mutant = candidates.length === 1 ? byId.get(candidates[0].id) : undefined;
    const annotation = s3Annotations.find((a) => a.file === s.file && a.line === s.line && a.op === s.op && a.from === s.original && a.to === s.replacement);
    return { s3Id: s.id, line: s.line, column: col, operator: s.op, from: s.original, to: s.replacement,
      class: annotation?.class ?? null, note: annotation?.note ?? null, baselineStatus: s.status, matchCount: candidates.length,
      currentStatus: mutant?.status ?? 'not-run', killedByNew: (mutant?.killedBy ?? []).filter((id) => newSet.has(id)) };
  });
}

async function measure(dirArgument) {
  const dir = resolve(dirArgument);
  if (!dir.startsWith(`${experiments}/`)) throw new Error(`arm must be under ${experiments}`);
  const meta = JSON.parse(readFileSync(join(dir, '.s8.json'), 'utf8'));
  const task = taskById(meta.taskId);
  if (task.module !== meta.module || meta.assayCommit !== baseline) throw new Error('arm metadata does not match task or Assay baseline');
  const { definitions, addedLines } = newDefinitions(dir);
  const sourceChanges = [
    ...checked('git', ['diff', '--name-only', 'HEAD', '--', 'src'], { cwd: dir }).trim().split('\n').filter(Boolean),
    ...checked('git', ['ls-files', '--others', '--exclude-standard', '--', 'src'], { cwd: dir }).trim().split('\n').filter(Boolean),
  ];
  const result = { ...meta, dir, newTestCount: definitions.length, addedLines, sourceChanges,
    protocolValid: sourceChanges.length === 0 && definitions.length > 0,
    newTestIds: [], verdicts: [], newTestsPass: null, mutation: null, s3Survivors: [] };
  if (definitions.length) {
    const input = await collectNode({ root: dir, config: { runners: { node: { tests: 'tests/*.test.mjs' } } }, runs: 1 });
    const ids = matchIds(definitions, input.tests);
    const inputFile = join(dir, 's8-input.json');
    writeFileSync(inputFile, JSON.stringify(input));
    const check = run(node, [cupel, 'check', ...ids, '--input', inputFile, '--no-mutation', '--runs', '1', '--json'], { cwd: dir });
    if (![0, 1].includes(check.status)) throw new Error(`cupel check failed: ${check.stderr.trim()}`);
    const report = JSON.parse(check.stdout);
    result.newTestIds = ids;
    result.verdicts = report.check.verdicts;
    result.newTestsPass = ids.every((id) => input.tests.find((t) => t.id === id)?.status === 'passed');
    if (!result.newTestsPass) result.protocolValid = false;
    if (result.newTestsPass) {
      const maxMutants = task.id === 'billing-ledger' ? 400 : task.id === 'billing-threshold' ? 250 : 150;
      const mutation = await mutateNode({ root: dir, input, config: { mutation: { maxMutants, maxSeconds: 1800, seed: 20261021 } }, scope: { critical: false, targeted: [], changed: { [task.module]: '' } } });
      result.mutation = { seed: mutation.seed, sampled: mutation.sampled, mutantCount: mutation.mutants.length, maxMutants,
        newTestKills: mutation.mutants.filter((m) => m.status === 'killed' && (m.killedBy ?? []).some((id) => ids.includes(id))).length };
      result.s3Survivors = s3Matches(dir, task.module, mutation, ids);
      result.s3SurvivorsKilled = result.s3Survivors.filter((s) => s.currentStatus === 'killed' && s.killedByNew.length > 0).length;
      if (mutation.sampled || result.s3Survivors.some((s) => s.matchCount !== 1 || s.currentStatus === 'not-run')) result.protocolValid = false;
    } else result.mutationSkipped = 'new tests did not all pass';
  }
  const timing = join(dir, 'arm-timing.json');
  const log = join(dir, 'codex.jsonl');
  const timingData = existsSync(timing) ? JSON.parse(readFileSync(timing, 'utf8')) : null;
  result.armWallMs = timingData ? timingData.endedMs - timingData.startedMs : null;
  result.armExit = timingData?.exit ?? null;
  result.tokenUsage = existsSync(log) ? usageFromLog(log) : null;
  result.cupelToolCalled = meta.arm === 'cupel' ? (result.tokenUsage?.cupelCheckCalls ?? 0) > 0 : null;
  if (result.armExit !== 0 || !result.tokenUsage || (meta.arm === 'cupel' && result.cupelToolCalled !== true)) result.protocolValid = false;
  writeFileSync(join(dir, 'measure.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function summarise() {
  const rows = [];
  if (existsSync(experiments)) for (const name of readdirSync(experiments)) {
    const path = join(experiments, name, 'measure.json');
    if (!existsSync(path)) continue;
    const r = JSON.parse(readFileSync(path, 'utf8'));
    rows.push({ task: r.taskId, arm: r.arm, rep: r.rep, valid: r.protocolValid, tool: r.cupelToolCalled,
      tests: r.newTestCount, addedLines: r.addedLines,
      addsNothing: r.verdicts.filter((v) => v.verdict === 'adds-nothing').length, pass: r.newTestsPass,
      s3Killed: r.s3SurvivorsKilled ?? 0, mutationSampled: r.mutation?.sampled ?? null,
      wallMs: r.armWallMs, inputTokens: r.tokenUsage?.inputTokens ?? null, outputTokens: r.tokenUsage?.outputTokens ?? null });
  }
  rows.sort((a, b) => a.task.localeCompare(b.task) || a.rep - b.rep || a.arm.localeCompare(b.arm));
  const head = '| Task | Arm | Rep | Valid | Cupel called | Tests | Lines + | Adds nothing | Pass | S3 killed | Mutation sampled | Wall ms | Input tokens | Output tokens |';
  const table = [head, '|---|---|---:|---|---|---:|---:|---:|---|---:|---|---:|---:|---:|',
    ...rows.map((r) => `| ${r.task} | ${r.arm} | ${r.rep} | ${r.valid} | ${r.tool ?? '—'} | ${r.tests} | ${r.addedLines} | ${r.addsNothing} | ${r.pass ?? '—'} | ${r.s3Killed} | ${r.mutationSampled ?? '—'} | ${r.wallMs ?? '—'} | ${r.inputTokens ?? '—'} | ${r.outputTokens ?? '—'} |`)];
  writeFileSync(join(here, 'summary.md'), `${table.join('\n')}\n`);
  return { rows: rows.length, path: join(here, 'summary.md') };
}

try {
  const [command, ...args] = process.argv.slice(2);
  let result;
  if (command === 'prepare' && args.length === 3) result = prepare(...args);
  else if (command === 'measure' && args.length === 1) result = await measure(args[0]);
  else if (command === 'summarise' && args.length === 0) result = summarise();
  else throw new Error('usage: ab.mjs prepare <task-id> <plain|cupel> <rep> | measure <dir> | summarise');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`s8: ${error.message}\n`);
  process.exitCode = 1;
}
