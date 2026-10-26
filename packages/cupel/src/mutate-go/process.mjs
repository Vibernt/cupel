import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { GoMutationError, refuse } from './errors.mjs';

const MAX_OUTPUT = 16 * 1024 * 1024;
const DRAIN_MS = 5_000;

export function goEnv(root) {
  for (const key of ['GOFLAGS', 'GOEXPERIMENT', 'GOOS', 'GOARCH'])
    if (process.env[key]) refuse('unsupported-go-environment', `${key} is set; this Go mutation profile requires the native default build`);
  if (process.env.GOWORK && process.env.GOWORK !== 'off')
    refuse('unsupported-go-environment', 'GOWORK is set; workspace mode is unverified for Go mutation');
  if (process.env.CGO_ENABLED && process.env.CGO_ENABLED !== '0')
    refuse('unsupported-go-environment', 'CGO_ENABLED is set; cgo mode is unverified for Go mutation');
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'go.work'))) refuse('unsupported-go-environment', 'go.work is present; workspace mode is unverified for Go mutation');
    if (dirname(dir) === dir) break;
  }
  const tmp = join(root, '.scratch', 'cupel-go', 'tmp');
  mkdirSync(tmp, { recursive: true });
  return { ...process.env, TMPDIR: tmp, GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local',
    GOWORK: 'off', CGO_ENABLED: '0', GOFLAGS: '', GOEXPERIMENT: '' };
}

export function run(command, args, { root, env, input, timeoutMs = 600_000 }) {
  return new Promise((resolve, reject) => {
    if (!['darwin', 'linux', 'freebsd', 'openbsd', 'netbsd'].includes(process.platform)) {
      reject(new GoMutationError('unsupported-process-host', 'Go mutation needs POSIX process-group termination'));
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
        reject(new GoMutationError('process-tree-not-drained', `${command} process group did not close its pipes after SIGKILL`));
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
      if (inputError) reject(new GoMutationError('process-error', `${command}: ${inputError.message}`));
      else if (overflow) reject(new GoMutationError('output-limit', `${command} output exceeded ${MAX_OUTPUT} bytes`));
      else resolve({ status, signal, stdout, stderr, timedOut, wallMs: performance.now() - started });
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}
