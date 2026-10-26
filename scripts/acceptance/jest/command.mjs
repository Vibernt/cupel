import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

/** Preserve whole-call cost and complete output without printing test contents. */
export function command(directory, label, executable, args, options = {}) {
  mkdirSync(directory, { recursive:true });
  const start = performance.now();
  const result = spawnSync(executable, args, { encoding:'utf8', timeout:600_000,
    maxBuffer:64 * 1024 * 1024, ...options });
  const record = { label, executable, args, cwd:options.cwd,
    exit:result.status, signal:result.signal, error:result.error?.message,
    wallMs:Math.round(performance.now() - start), stdout:join(directory, `${label}.stdout.log`),
    stderr:join(directory, `${label}.stderr.log`) };
  writeFileSync(record.stdout, result.stdout ?? '');
  writeFileSync(record.stderr, result.stderr ?? '');
  writeFileSync(join(directory, `${label}.command.json`), JSON.stringify(record,null,2) + '\n');
  return { ...record, stdoutText:result.stdout ?? '', stderrText:result.stderr ?? '' };
}
