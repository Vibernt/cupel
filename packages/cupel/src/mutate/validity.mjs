// Validity filter for mutants (D6): every mutant must still parse. ES modules are parsed with
// `vm.SourceTextModule` (which needs --experimental-vm-modules, so a worker process with that flag does it when this
// process lacks it), CommonJS with `vm.compileFunction`. When the worker cannot run, `node --check` is the fallback.

import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./validate-worker.mjs', import.meta.url));
const CJS_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname'];

/** In-process parse of each { mode, text }: null when it parses, else the error message. */
export function parseErrors(items) {
  return items.map(({ mode, text }) => {
    try {
      if (mode === 'commonjs') vm.compileFunction(text, CJS_PARAMS);
      else new vm.SourceTextModule(text);
      return null;
    } catch (error) {
      return `${error?.name ?? 'Error'}: ${error?.message ?? error}`;
    }
  });
}

function run(argv, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** One `node --check` per item, reading the text from standard input. */
async function checkEach(items) {
  const out = [];
  for (const { mode, text } of items) {
    const r = await run([`--input-type=${mode === 'commonjs' ? 'commonjs' : 'module'}`, '--check'], text);
    out.push(r.code === 0 ? null : (r.stderr.split('\n').find((l) => /Error/.test(l)) ?? `node --check exited ${r.code}`).trim());
  }
  return out;
}

/**
 * Parse errors of each { mode, text }, in order (null = valid). Returns { errors, method } where method names what
 * checked them: 'in-process', 'worker' or 'node --check'.
 */
export async function checkValidity(items) {
  if (items.length === 0) return { errors: [], method: 'none' };
  const needsModules = items.some((i) => i.mode !== 'commonjs');
  if (!needsModules || typeof vm.SourceTextModule === 'function') return { errors: parseErrors(items), method: 'in-process' };
  const r = await run(['--experimental-vm-modules', '--no-warnings', WORKER], JSON.stringify(items));
  if (r.code === 0) {
    try {
      const errors = JSON.parse(r.stdout);
      if (Array.isArray(errors) && errors.length === items.length) return { errors, method: 'worker' };
    } catch { /* fall through to node --check */ }
  }
  return { errors: await checkEach(items), method: 'node --check' };
}
