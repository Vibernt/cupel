// Enumerate mutation edit descriptors source by source, without retaining source texts.

import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join } from 'node:path';
import { generateMutants } from './operators.mjs';
import { checkValidity } from './validity.mjs';
import { parseTypeScript, projectTypeScript, scanJsx } from '../lang/js/project-typescript.mjs';
import { skipFile } from '../collect/skipped.mjs';

const JS_EXTENSIONS = new Set(['.mjs', '.js', '.cjs']);
const TS_EXTENSIONS = new Set(['.ts', '.mts', '.cts']);
const JSX_EXTENSIONS = new Set(['.jsx', '.tsx']);

export function sourceMutants(root, source, text, ts) {
  const ext = extname(source);
  if (TS_EXTENSIONS.has(ext)) {
    let stripped;
    try { stripped = stripTypeScriptTypes(text); }
    catch (stripError) {
      ts ??= projectTypeScript(root);
      if (!ts) throw new Error(`${stripError.message}; typescript is not resolvable from the project root`);
      return generateMutants(source, text, scanJsx(ts, source, text).tokens).map((m) => ({ ...m, mode: 'typescript-scanned' }));
    }
    return generateMutants(source, stripped).map((m) => ({ ...m, mode: 'typescript' }));
  }
  if (JSX_EXTENSIONS.has(ext)) {
    ts ??= projectTypeScript(root);
    if (!ts) return null;
    return generateMutants(source, text, scanJsx(ts, source, text).tokens).map((m) => ({ ...m, mode: 'jsx' }));
  }
  return generateMutants(source, text);
}

export async function candidateValidity(root, items) {
  const ts = items.some(({ m }) => m.mode === 'jsx' || m.mode === 'typescript-scanned') ? projectTypeScript(root) : null;
  const errors = new Array(items.length);
  const js = [];
  for (let i = 0; i < items.length; i++) {
    const { m, text } = items[i];
    try {
      if (m.mode === 'jsx' || m.mode === 'typescript-scanned') {
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

export async function enumerateSites({ root, lines, log, diagnostics = [] }) {
  const skipped = new Map();
  const candidates = [];
  const stats = { generated: 0, logging: 0, outOfScope: 0 };
  for (const [source, wanted] of lines) {
    const ext = extname(source);
    if (![...JS_EXTENSIONS, ...TS_EXTENSIONS, ...JSX_EXTENSIONS].includes(ext)) {
      skipped.set(source, 'not a JavaScript or TypeScript source');
      continue;
    }
    let text, all;
    try {
      const ts = JSX_EXTENSIONS.has(ext) ? projectTypeScript(root) : null;
      if (JSX_EXTENSIONS.has(ext) && !ts) throw new Error('typescript is not resolvable from the project root');
      text = readFileSync(join(root, source), 'utf8');
      all = sourceMutants(root, source, text, ts);
    } catch (error) {
      skipped.set(source, String(error?.message ?? error));
      continue;
    }
    let tsMode = all[0]?.mode;
    if (TS_EXTENSIONS.has(ext) && !tsMode) {
      try { stripTypeScriptTypes(text); tsMode = 'typescript'; }
      catch { tsMode = 'typescript-scanned'; }
    }
    const modes = TS_EXTENSIONS.has(ext) ? [tsMode] : ext === '.mjs' ? ['module'] : ext === '.cjs' ? ['commonjs'] :
      JSX_EXTENSIONS.has(ext) ? ['jsx'] : ['module', 'commonjs'];
    let probe;
    try { probe = await candidateValidity(root, modes.map((mode) => ({ m: { mode, source }, text }))); }
    catch (error) { skipped.set(source, String(error?.message ?? error)); continue; }
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
  for (const [source, reason] of skipped) skipFile(diagnostics, log, 'mutate', source, reason);
  log(`mutate: ${stats.generated} generated, ${stats.outOfScope} outside the scope, ${stats.logging} logging-only, ${candidates.length} sites`);
  return { candidates, skipped: new Set(skipped.keys()), stats };
}
