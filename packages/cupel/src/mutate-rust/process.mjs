import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { RustMutationError, refuse } from './errors.mjs';

const MAX_OUTPUT = 16 * 1024 * 1024;
const DRAIN_MS = 5_000;

export function run(command, args, { root, env, input, timeoutMs = 600_000 }) {
  return new Promise((resolve, reject) => {
    if (!['darwin', 'linux', 'freebsd', 'openbsd', 'netbsd'].includes(process.platform)) {
      reject(new RustMutationError('unsupported-process-host', 'Rust mutation needs POSIX process-group termination'));
      return;
    }
    const started = performance.now();
    const child = spawn(command, args, { cwd: root, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', outputBytes = 0, overflow = false, timedOut = false;
    let inputError, drainTimer, closed = false;
    const stopTree = (reason) => {
      if (closed || drainTimer) return;
      if (reason === 'timeout') timedOut = true;
      if (reason === 'output-limit') overflow = true;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') inputError = error; }
      }
      drainTimer = setTimeout(() => {
        reject(new RustMutationError('process-tree-not-drained', `${command} process group did not close its pipes after SIGKILL`));
      }, DRAIN_MS);
    };
    const timer = setTimeout(() => stopTree('timeout'), timeoutMs);
    const add = (name, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT) {
        stopTree('output-limit');
      } else if (name === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on('data', (chunk) => add('stdout', chunk));
    child.stderr.on('data', (chunk) => add('stderr', chunk));
    child.stdin.on('error', (error) => { inputError = error; });
    child.on('error', (error) => { inputError = error; stopTree('spawn-error'); });
    child.on('close', (status, signal) => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      if (inputError) reject(new RustMutationError('process-error', `${command}: ${inputError.message}`));
      else if (overflow) reject(new RustMutationError('output-limit', `${command} output exceeded ${MAX_OUTPUT} bytes`));
      else resolve({ status, signal, stdout, stderr, timedOut, wallMs: performance.now() - started });
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}
