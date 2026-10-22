// S8 retrospective: read Assay's history, analyse each commit in an isolated archive.
// No writes are made to the Assay repository.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { definitionsFromDiff, parseTitle } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cupelRoot = resolve(here, '../../..');
const assay = '/Users/vid/cupel/.scratch/assay-base';
const output = join(here, 'retrospective.json');
const node = '/opt/homebrew/bin/node';
const cupel = join(cupelRoot, 'packages/cupel/bin/cupel.mjs');

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
}

function git(args) {
  const result = run('git', ['-C', assay, ...args]);
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr.trim()}`);
  return result.stdout;
}
const assayRef = git(['rev-parse', 'assay-main']).trim();
if (assayRef !== '5a5a13133c9e6dfb323b49a340051e955cd9edeb') throw new Error(`assay-main moved to ${assayRef}`);

function addedDefinitions(commit) {
  const diff = git(['diff', `${commit}^`, commit, '--', 'tests/*.test.mjs']);
  const candidates = definitionsFromDiff(diff);
  const previous = new Map();
  for (const file of new Set(candidates.map((d) => d.file))) {
    const existed = git(['ls-tree', '--name-only', `${commit}^`, '--', file]).trim() === file;
    const names = existed ? git(['show', `${commit}^:${file}`]).split('\n').map(parseTitle).filter((x) => x !== null) : [];
    previous.set(file, new Set(names));
  }
  return candidates.filter((d) => !previous.get(d.file).has(d.name)).map((d) => ({ ...d, id: `${d.file}::${d.name}` }));
}

const commits = git(['log', 'assay-main', '--no-merges', '--format=%H']).trim().split('\n');
const selected = [];
for (const commit of commits) {
  const definitions = addedDefinitions(commit);
  if (definitions.length === 0 || definitions.length > 60) continue;
  selected.push({ commit, definitions });
  if (selected.length === 10) break;
}
if (selected.length !== 10) throw new Error(`only ${selected.length} qualifying commits`);
const manifest = selected.map(({ commit, definitions }) => {
  const metadata = git(['show', '-s', '--format=%s%n%an <%ae>%n%b', commit]).trim().split('\n');
  return { commit, subject: metadata[0], author: metadata[1],
    agentCoAuthor: metadata.slice(2).some((s) => /^Co-Authored-By:\s*.*(Claude|Codex|GPT|AI|Copilot)/i.test(s)), definitions };
});
writeFileSync(join(here, 'selection.json'), `${JSON.stringify({ assayRef, rows: manifest }, null, 2)}\n`);
if (process.argv.includes('--select-only')) process.exit(0);

let previous = [];
try { previous = JSON.parse(readFileSync(output, 'utf8')).rows.filter((r) => !r.error); } catch { /* first run */ }
const rows = [...previous];
for (let { commit, definitions, subject, author, agentCoAuthor } of manifest) {
  if (previous.some((r) => r.commit === commit)) continue;
  // Only Assay's own node:test glob (tests/*.test.mjs) is collected; workerd and nested suites are out of scope.
  definitions = definitions.filter((d) => /^tests\/[^/]+\.test\.mjs::/.test(d.id));
  if (!definitions.length) continue;
  const dir = mkdtempSync(join(tmpdir(), 's8-retro-'));
  const row = { commit, subject, author, agentCoAuthor, definitions };
  try {
    const archive = run('bash', ['-o', 'pipefail', '-c', `git -C '${assay}' archive '${commit}' | tar -x -C '${dir}'`]);
    if (archive.status !== 0) throw new Error(`archive: ${archive.stderr.trim()}`);
    const build = run(node, ['scripts/generate.mjs', '--build'], { cwd: dir });
    if (build.status !== 0) throw new Error(`build: ${build.stderr.trim().slice(-1000)}`);
    writeFileSync(join(dir, 'cupel.json'), JSON.stringify({ runners: { node: { tests: 'tests/*.test.mjs' } } }));
    const inputPath = join(dir, 's8-input.json');
    const started = Date.now();
    const check = run(node, [cupel, 'check', ...definitions.map((d) => d.id), '--no-mutation', '--runs', '1', '--json', '--out', inputPath, '--quiet'], { cwd: dir, timeout: 600000 });
    row.checkMs = Date.now() - started;
    row.exit = check.status;
    if (![0, 1].includes(check.status)) {
      let diagnostics = [];
      try { diagnostics = JSON.parse(check.stdout).diagnostics ?? []; } catch { /* not JSON */ }
      row.diagnostics = diagnostics;
      throw new Error(`check exit ${check.status}: ${JSON.stringify(diagnostics).slice(0, 800)} ${check.stderr.trim().slice(-400)}`);
    }
    row.collectionMs = Math.round(statSync(inputPath).mtimeMs - started);
    const report = JSON.parse(check.stdout);
    const input = JSON.parse(readFileSync(inputPath, 'utf8'));
    row.collectedTests = input.tests.length;
    row.verdicts = report.check.verdicts;
    row.missing = definitions.map((d) => d.id).filter((id) => !input.tests.some((t) => t.id === id));
    row.unmatchedVerdicts = definitions.map((d) => d.id).filter((id) => !row.verdicts.some((v) => v.id === id || input.tests.some((t) => t.id === id && t.unit === v.id)));
  } catch (error) {
    row.error = String(error.message);
  } finally {
    rows.push(row);
    writeFileSync(output, `${JSON.stringify({ assayRef, rows }, null, 2)}\n`);
    rmSync(dir, { recursive: true, force: true });
    process.stderr.write(`${commit.slice(0, 8)}: ${row.error ?? `${row.verdicts.length} verdicts in ${row.collectionMs}ms`}\n`);
  }
}
