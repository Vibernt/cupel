import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function goEnvironment(root) {
  const scratch = join(root, '.scratch', 'cupel-go');
  const dirs = {
    GOCACHE: join(scratch, 'cache'),
    GOMODCACHE: join(scratch, 'modcache'),
    GOPATH: join(scratch, 'gopath'),
    TMPDIR: join(scratch, 'tmp'),
  };
  for (const path of Object.values(dirs)) mkdirSync(path, { recursive: true });
  return { ...process.env, ...dirs, GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' };
}

export function execute(command, args, { root, env, allowFailure = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', (error) => reject(new Error(`${command}: ${error.message}`)));
    child.on('close', (status) => {
      if (status !== 0 && !allowFailure) reject(new Error(`${command} ${args.join(' ')} failed (${status}): ${(stderr || stdout).trim()}`));
      else resolve({ status, stdout, stderr });
    });
  });
}

export function jsonObjects(text) {
  const out = [];
  let start = -1;
  let depth = 0;
  let quote = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') quote = false;
    } else if (c === '"') quote = true;
    else if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && --depth === 0) out.push(JSON.parse(text.slice(start, i + 1)));
  }
  if (depth || quote) throw new Error('incomplete go list -json output');
  return out;
}

export async function parallel(items, limit, fn) {
  let next = 0;
  const output = Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await fn(items[index], index);
    }
  }));
  return output;
}
