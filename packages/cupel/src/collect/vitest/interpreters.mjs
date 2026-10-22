// The same Node-process recognition used by the node:test hook (K11).
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename, delimiter, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const NODE = /^(node|nodejs)(\.exe)?$/i;
const SHELL = /^(sh|bash|zsh|dash|ksh|ash|fish)$/;
const PREFIX = new Set(['exec', 'env', 'command', 'time', 'nice', 'nohup']);
const shebangs = new Map();
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

function hasNodeShebang(file) {
  if (shebangs.has(file)) return shebangs.get(file);
  let yes = false;
  try {
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(256);
    const count = readSync(fd, buf, 0, 256, 0);
    closeSync(fd);
    yes = /^#!.*\bnode(js)?\b/.test(buf.subarray(0, count).toString('utf8').split('\n')[0]);
  } catch { /* An unreadable command is not identified as a Node shim. */ }
  shebangs.set(file, yes);
  return yes;
}

function commandIsNode(cmd, env, cwd) {
  cmd = String(cmd ?? '').replace(/^['"]|['"]$/g, '');
  if (!cmd) return false;
  if (cmd === process.execPath || NODE.test(basename(cmd))) return true;
  let file = null;
  if (cmd.includes('/') || cmd.includes(sep)) file = resolve(cwd, cmd);
  else for (const dir of String(env?.PATH ?? env?.Path ?? '').split(delimiter)) {
    if (dir && isFile(join(dir, cmd))) { file = join(dir, cmd); break; }
  }
  return file !== null && (real(file) === real(process.execPath) || hasNodeShebang(file));
}

function shellRunsNode(line, env, cwd) {
  for (const part of String(line).split(/&&|\|\||\$\(|[;|&\n()`]/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    let index = 0;
    while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]) || PREFIX.has(words[index]))) index++;
    if (index < words.length && commandIsNode(words[index], env, cwd)) return true;
  }
  return false;
}

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
function optionsIndex(method, args) {
  if (method === 'exec' || method === 'execSync') return isPlain(args[1]) ? 1 : -1;
  const index = Array.isArray(args[1]) ? 2 : 1;
  return isPlain(args[index]) ? index : -1;
}

function startsNode(method, args) {
  if (method === 'fork') return true;
  const index = optionsIndex(method, args);
  const options = index >= 0 ? args[index] : {};
  const env = options.env ?? process.env;
  const cwd = options.cwd ? (options.cwd instanceof URL ? fileURLToPath(options.cwd) : String(options.cwd)) : process.cwd();
  if (method === 'exec' || method === 'execSync') return shellRunsNode(args[0], env, cwd);
  const file = String(args[0]);
  const argv = Array.isArray(args[1]) ? args[1].map(String) : [];
  if (options.shell) return shellRunsNode([file, ...argv].join(' '), env, cwd);
  if (commandIsNode(file, env, cwd)) return true;
  const name = basename(file);
  if (SHELL.test(name)) {
    const index = argv.indexOf('-c');
    return index >= 0 && argv[index + 1] !== undefined && shellRunsNode(argv[index + 1], env, cwd);
  }
  if (name === 'env') {
    const first = argv.find((arg) => !arg.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg));
    return first !== undefined && commandIsNode(first, env, cwd);
  }
  return false;
}

export function watchInterpreters(note) {
  for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const original = cp[method];
    const wrap = (target) => function cupelChildProcess(...args) {
      try { if (startsNode(method, args)) note(); } catch { /* Never change test execution. */ }
      return target.apply(this, args);
    };
    const wrapped = wrap(original);
    if (original[promisify.custom]) Object.defineProperty(wrapped, promisify.custom, { value: wrap(original[promisify.custom]), configurable: true });
    cp[method] = wrapped;
  }
  const workers = require('node:worker_threads');
  const OriginalWorker = workers.Worker;
  workers.Worker = class Worker extends OriginalWorker {
    constructor(...args) { note(); super(...args); }
  };
  syncBuiltinESMExports();
}
