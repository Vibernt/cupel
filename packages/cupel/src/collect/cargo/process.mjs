import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { availableParallelism } from 'node:os';

export function execute(command, args, { root, env, allowFailure = false, stdoutPath }) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const fd = stdoutPath ? openSync(stdoutPath, 'w') : null;
    let child;
    try { child = spawn(command, args, { cwd: root, env, stdio: ['ignore', fd ?? 'pipe', 'pipe'] }); }
    finally { if (fd !== null) closeSync(fd); }
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new Error(`${command}: ${error.message}`)));
    child.on('close', (status) => {
      if (status !== 0 && !allowFailure) reject(new Error(`${command} ${args.join(' ')} failed (${status}): ${(stderr || stdout).trim()}`));
      else resolve({ status, stdout, stderr, duration: Math.round(performance.now() - started) });
    });
  });
}

export async function parallel(items, fn, limit = Math.max(1, Math.floor(availableParallelism() / 2))) {
  let next = 0;
  const output = Array(items.length);
  const workers = Math.min(items.length, Math.max(1, Math.floor(limit)));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < items.length) { const index = next++; output[index] = await fn(items[index], index); }
  }));
  return output;
}
