import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSealed, saveJson } from './artifacts.mjs';
import { baseRoot, cases, project } from './fixture.mjs';
import { inventoryMetadata, summarizeFsCounters } from './counters.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const preload = join(here, 'diagnostic-preload.cjs');
const one = join(here, 'diagnostic-one.mjs');
const profile = join(project, 'plans/spikes/s12b/node-profile');

export function diagnoseRun({ runDir, nodePath }) {
  const saved = loadSealed(runDir);
  if (!process.env.PATH) throw new Error('S16 diagnostic requires explicit PATH for Node');
  const summary = { version: 's16-diagnostic/1',
    observer: 'one diagnostic parent per case/method; parent CPU/RSS and raw external time kept separate',
    inventory: { baseline: inventoryMetadata(baseRoot, saved['bundle.json'].core.identity.files),
      heads: Object.fromEntries(cases.map(item => [item.name,
        inventoryMetadata(item.root, saved['bundle.json'].core.identity.files)])) },
    results: {} };
  for (const item of cases) for (const method of ['old', 'candidate', 'full']) {
    const label = `diagnostic-${item.name}-${method}`;
    const report = join(runDir, `${label}-fs.json`);
    const env = { PATH: process.env.PATH, CI: '1', NO_COLOR: '1', TZ: 'UTC', LANG: 'C',
      S16_DIAG_ROOT: item.root, S16_DIAG_BASE_ROOT: baseRoot,
      S16_DIAG_PROFILE_ROOT: profile, S16_DIAG_COORD_ROOT: resolve(here),
      S16_DIAG_PROJECT_ROOT: project,
      S16_DIAG_REPORT: report };
    const command = [nodePath, `--require=${preload}`, one, runDir, item.name, method];
    const run = spawnSync('/usr/bin/time', ['-l', ...command], { cwd: project, env,
      encoding: 'utf8', timeout: 60000, maxBuffer: 8 << 20 });
    writeFileSync(join(runDir, `${label}-time.txt`), `${run.stdout ?? ''}\n${run.stderr ?? ''}`);
    if (run.error || run.status !== 0)
      throw new Error(`S16 diagnostic ${label} failed; see raw time output`);
    const counters = JSON.parse(readFileSync(report, 'utf8'));
    if (counters.opaqueReadDenied || counters.unattributedFdReads)
      throw new Error(`S16 diagnostic ${label} read/probe attribution incomplete`);
    const evidence = JSON.parse(readFileSync(join(runDir, `${label}.json`), 'utf8'));
    summary.results[`${item.name}:${method}`] = {
      parentCounters: counters, aggregateFs: summarizeFsCounters(counters),
      traceBytes: evidence.traceBytes,
      wallMs: evidence.result.wallMs,
      phases: evidence.result.timings ?? evidence.result.step ?? null,
      selectedProcesses: evidence.result.counters?.selectedProcesses ??
        evidence.result.capture?.timings?.length ?? null,
      childWallMs: evidence.result.capture?.timings?.map(row => row.ms) ?? null,
      rawTime: `${label}-time.txt` };
  }
  saveJson(runDir, 'diagnostic-summary.json', summary);
  return summary;
}
