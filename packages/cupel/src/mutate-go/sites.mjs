import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmp } from '../engine/order.mjs';
import { refuse } from './errors.mjs';
import { run } from './process.mjs';

const helperDir = join(dirname(fileURLToPath(import.meta.url)), 'ast-helper');
const shortHash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 8);

export async function buildHelper(scratch, env, timeoutMs) {
  const binary = join(scratch, 'go-ast-helper');
  const result = await run('go', ['build', '-o', binary, '.'], {
    root: helperDir, env: { ...env, GOWORK: 'off' }, timeoutMs: Math.max(1, Math.min(timeoutMs, 120_000)),
  });
  if (result.status !== 0 || result.signal || result.timedOut)
    refuse('go-helper', `Go AST helper could not build offline: ${result.stderr.trim()}`);
  return binary;
}

export async function sourceSites(helper, source, bytes, lines, root, env, timeoutMs = 30_000) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) refuse('source-encoding', `Go source is not UTF-8: ${source}`);
  const result = await run(helper, [], { root, env, input: JSON.stringify({ source, text }), timeoutMs: Math.max(1, Math.min(timeoutMs, 30_000)) });
  if (result.status !== 0 || result.signal || result.timedOut)
    refuse('go-helper', `Go AST helper failed for ${source}: ${result.stderr.trim()}`);
  let response;
  try { response = JSON.parse(result.stdout); }
  catch { refuse('go-helper', `Go AST helper returned invalid JSON for ${source}`); }
  if (response.error) refuse('source-parse', `Go source does not parse: ${source}: ${response.error}`);
  if (!Array.isArray(response.sites)) refuse('go-helper', `Go AST helper returned no site list for ${source}`);
  const out = [];
  for (const site of response.sites) {
    if (!lines.has(site.line)) continue;
    const { start, end, original, replacement, operator, line, column } = site;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > bytes.length ||
        bytes.subarray(start, end).toString('utf8') !== original)
      refuse('go-helper', `Go AST site offset mismatch for ${source}:${line}`);
    const id = `${source}:${line}:${column}:${operator}:${shortHash(`${original}\0${replacement}`)}`;
    out.push({ id, source, line, column, operator, start, end, original, replacement });
  }
  return out.sort((a, b) => a.start - b.start || cmp(a.operator, b.operator) || cmp(a.id, b.id));
}

export function applyGoSite(bytes, site) {
  return Buffer.concat([
    bytes.subarray(0, site.start), Buffer.from(site.replacement), bytes.subarray(site.end),
  ]);
}
