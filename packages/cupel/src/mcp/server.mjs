// One JSON-RPC message per line over stdio. stdout is reserved for protocol responses.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gitRoot } from '../cli/git.mjs';
import { TOOLS, callTool, validateCall } from './tools.mjs';
import { ReportSnapshots } from './report-snapshots.mjs';

const SUPPORTED = new Set(['2025-06-18', '2025-03-26']);
const NEWEST = '2025-06-18';
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });

async function dispatch(message, context) {
  if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
    || (Object.hasOwn(message, 'id') && message.id !== null && typeof message.id !== 'string' && typeof message.id !== 'number')) {
    const id = object(message) && (message.id === null || typeof message.id === 'string' || typeof message.id === 'number') ? message.id : null;
    return error(id, -32600, 'Invalid Request');
  }
  const notification = !Object.hasOwn(message, 'id');
  const id = notification ? null : message.id;
  const params = message.params === undefined ? {} : message.params;
  if (message.method === 'notifications/initialized') return null;
  if (notification) return null;
  if (!object(params)) return error(id, -32602, 'Invalid params: expected an object');
  switch (message.method) {
    case 'initialize':
      if (typeof params.protocolVersion !== 'string' || !params.protocolVersion) return error(id, -32602, 'Invalid params: protocolVersion must be a string');
      return ok(id, {
        protocolVersion: SUPPORTED.has(params.protocolVersion) ? params.protocolVersion : NEWEST,
        capabilities: { tools: {} },
        serverInfo: { name: 'cupel', version: VERSION },
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'tools/call': {
      if (typeof params.name !== 'string') return error(id, -32602, 'Invalid params: name must be a tool name');
      const args = params.arguments === undefined ? {} : params.arguments;
      const invalid = validateCall(params.name, args);
      if (invalid) return error(id, -32602, `Invalid params: ${invalid}`);
      return ok(id, await callTool(params.name, args, context));
    }
    default:
      return error(id, -32601, 'Method not found');
  }
}

export async function startServer({ cwd, env, rootOption, err }) {
  const requested = resolve(cwd, rootOption ?? '.');
  const root = gitRoot(requested);
  if (!root) {
    err(`cupel mcp: ${requested} is not inside a git repository\n`);
    return 3;
  }
  if (rootOption !== undefined && resolve(root) !== requested) {
    err(`cupel mcp: --root must name the git repository root (${root})\n`);
    return 2;
  }
  const context = { root, env, reportSnapshots: new ReportSnapshots(root) };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify(error(null, -32700, 'Parse error'))}\n`);
      continue;
    }
    let response;
    try {
      response = await dispatch(message, context);
    } catch (cause) {
      err(`cupel mcp: ${cause?.stack ?? cause}\n`);
      response = error(object(message) && Object.hasOwn(message, 'id') ? message.id : null, -32603, 'Internal error');
    }
    if (response !== null) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
  return 0;
}
