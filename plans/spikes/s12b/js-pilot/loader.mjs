// ESM resolve hook: catches linkage even when Node's internal loader bypasses patched fs.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as pathResolve, relative, sep } from 'node:path';
const root = pathResolve(process.env.CUPEL_TRACE_ROOT || '.');
const out = process.env.CUPEL_TRACE_OUT;
const owner = process.env.CUPEL_TRACE_OWNER;
const rel = url => {
  try {
    const path = fileURLToPath(url);
    const name = relative(root, path).split(sep).join('/');
    return name && name !== '..' && !name.startsWith('../') &&
      !name.split('/').some(part => part.startsWith('.') || part === 'node_modules') ? name : null;
  } catch { return null; }
};
export async function resolve(specifier, context, nextResolve) {
  try {
    const answer = await nextResolve(specifier, context);
    const file = rel(answer.url);
    if (file) appendFileSync(out, JSON.stringify({ owner, file, kind:'esm-resolve', result:'present',
      parent:rel(context.parentURL), direct:context.parentURL?.includes(owner) ?? false }) + '\n');
    return answer;
  } catch (error) {
    appendFileSync(out, JSON.stringify({ owner, file:specifier, kind:'esm-resolve', result:'error',
      parent:rel(context.parentURL), code:error.code }) + '\n');
    throw error;
  }
}
