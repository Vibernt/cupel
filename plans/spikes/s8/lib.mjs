import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
}

export function checked(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) throw new Error(`${command} ${args[0]} exited ${result.status}: ${result.stderr.trim().slice(-1000)}`);
  return result.stdout;
}

export function parseTitle(line) {
  const match = /^\+?\s*(?:test|it)\((['"])/.exec(line);
  if (!match) return null;
  let value = '';
  let escaped = false;
  for (const char of line.slice(match[0].length)) {
    if (escaped) { value += char; escaped = false; }
    else if (char === '\\') escaped = true;
    else if (char === match[1]) return value;
    else value += char;
  }
  throw new Error(`unclosed test title: ${line}`);
}

export function definitionsFromDiff(diff) {
  const out = [];
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) file = line.slice(6);
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const name = parseTitle(line);
    if (name !== null && file) out.push({ file, name });
  }
  return out;
}

export function matchIds(definitions, tests) {
  return definitions.map(({ file, name }) => {
    const matches = tests.filter((t) => t.file === file && (t.id === `${file}::${name}` || t.id.endsWith(` ${name}`)));
    if (matches.length !== 1) throw new Error(`${file}::${name}: expected one collected test, found ${matches.length}`);
    return matches[0].id;
  });
}

export function lineCount(text) {
  if (text === '') return 0;
  return text.split('\n').length - Number(text.endsWith('\n'));
}

export function usageFromLog(path) {
  let inputTokens = 0;
  let outputTokens = 0;
  let completedTurns = 0;
  const cupelCalls = new Set();
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    if (['item.started', 'item.completed'].includes(event.type) && event.item?.type === 'mcp_tool_call'
      && /(^|__)cupel_check$/.test(event.item?.tool ?? '')) cupelCalls.add(event.item.id ?? `${event.type}:${cupelCalls.size}`);
    if (event.type !== 'turn.completed' || !event.usage) continue;
    completedTurns++;
    inputTokens += event.usage.input_tokens ?? 0;
    outputTokens += event.usage.output_tokens ?? 0;
  }
  return { completedTurns, inputTokens, outputTokens, cupelCheckCalls: cupelCalls.size };
}

export function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
