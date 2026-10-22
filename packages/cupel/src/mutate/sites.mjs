// Enumerate mutation edit descriptors source by source, without retaining source texts.

import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join } from 'node:path';
import { generateMutants } from './operators.mjs';
import { checkValidity } from './validity.mjs';
import { parseTypeScript, projectTypeScript, scanJsx } from '../lang/js/project-typescript.mjs';

const JS_EXTENSIONS = new Set(['.mjs', '.js', '.cjs']);
const TS_EXTENSIONS = new Set(['.ts', '.mts', '.cts']);
const JSX_EXTENSIONS = new Set(['.jsx', '.tsx']);

export function sourceMutants(root, source, text, ts) {
  const ext = extname(source);
  if (TS_EXTENSIONS.has(ext)) return generateMutants(source, stripTypeScriptTypes(text)).map((m) => ({ ...m, mode: 'typescript' }));
  if (JSX_EXTENSIONS.has(ext)) {
    ts ??= projectTypeScript(root);
    if (!ts) return null;
    return generateMutants(source, text, scanJsx(ts, source, text).tokens).map((m) => ({ ...m, mode: 'jsx' }));
  }
  return generateMutants(source, text);
}

export async function candidateValidity(root, items) {
  const ts = items.some(({ m }) => m.mode === 'jsx') ? projectTypeScript(root) : null;
  const errors = new Array(items.length);
  const js = [];
  for (let i = 0; i < items.length; i++) {
    const { m, text } = items[i];
    try {
      if (m.mode === 'jsx') {
        if (!ts) throw new Error('typescript is not resolvable from the project root');
        errors[i] = parseTypeScript(ts, m.source, text);
      } else if (m.mode === 'typescript') {
        const stripped = stripTypeScriptTypes(text);
        js.push({ index: i, mode: /\.cts$/.test(m.source) ? 'commonjs' : 'module', text: stripped });
      } else js.push({ index: i, mode: m.mode, text });
    } catch (error) { errors[i] = String(error.message ?? error); }
  }
  const checked = await checkValidity(js);
  js.forEach(({ index }, k) => { errors[index] = checked.errors[k]; });
  return { errors };
}

export async function enumerateSites({ root, lines, log }) {
  const skipped = new Map();
  const candidates = [];
  const stats = { generated: 0, logging: 0, outOfScope: 0 };
  for (const [source, wanted] of lines) {
    const ext = extname(source);
    if (![...JS_EXTENSIONS, ...TS_EXTENSIONS, ...JSX_EXTENSIONS].includes(ext)) {
      skipped.set(source, 'not a JavaScript or TypeScript source');
      continue;
    }
    const ts = JSX_EXTENSIONS.has(ext) ? projectTypeScript(root) : null;
    if (JSX_EXTENSIONS.has(ext) && !ts) { skipped.set(source, 'typescript is not resolvable from the project root'); continue; }
    let text, all;
    try {
      text = readFileSync(join(root, source), 'utf8');
      all = sourceMutants(root, source, text, ts);
    } catch (error) {
      skipped.set(source, String(error?.message ?? error));
      continue;
    }
    const modes = TS_EXTENSIONS.has(ext) ? ['typescript'] : ext === '.mjs' ? ['module'] : ext === '.cjs' ? ['commonjs'] :
      JSX_EXTENSIONS.has(ext) ? ['jsx'] : ['module', 'commonjs'];
    const probe = await candidateValidity(root, modes.map((mode) => ({ m: { mode, source }, text })));
    const mode = modes.find((_, k) => probe.errors[k] === null);
    if (!mode) {
      skipped.set(source, 'the unmutated source does not parse');
      continue;
    }
    for (const m of all) {
      stats.generated++;
      if (!wanted.has(m.line)) stats.outOfScope++;
      else if (m.filtered) stats.logging++;
      else candidates.push({ ...m, mode });
    }
  }
  for (const [source, reason] of skipped) log(`mutate: skipped ${source}: ${reason}`);
  log(`mutate: ${stats.generated} generated, ${stats.outOfScope} outside the scope, ${stats.logging} logging-only, ${candidates.length} sites`);
  return { candidates, skipped: new Set(skipped.keys()), stats };
}
