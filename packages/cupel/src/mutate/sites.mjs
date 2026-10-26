// Enumerate mutation edit descriptors source by source, without retaining source texts.

import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join } from 'node:path';
import { generateMutants } from './operators.mjs';
import { bodySites } from './body-sites.mjs';
import { checkValidity } from './validity.mjs';
import { parseTypeScript, projectTypeScript, scanJsx } from '../lang/js/project-typescript.mjs';
import { skipFile } from '../collect/skipped.mjs';
import { lexFacts } from './lex-facts.mjs';
import { SourceChangedError } from './source-facts.mjs';

const JS_EXTENSIONS = new Set(['.mjs', '.js', '.cjs']);
const TS_EXTENSIONS = new Set(['.ts', '.mts', '.cts']);
const JSX_EXTENSIONS = new Set(['.jsx', '.tsx']);

export function sourceMutants(root, source, text, ts, functions = false, metrics) {
  const generate = (value, scanned) => {
    const { tokens, pairs } = lexFacts(value, scanned, metrics);
    return functions ? bodySites(source, value, tokens, pairs) :
      [...generateMutants(source, value, tokens, pairs),
        ...bodySites(source, value, tokens, pairs)];
  };
  const ext = extname(source);
  if (TS_EXTENSIONS.has(ext)) {
    let stripped;
    try { stripped = stripTypeScriptTypes(text); }
    catch (stripError) {
      ts ??= projectTypeScript(root);
      if (!ts) throw new Error(`${stripError.message}; typescript is not resolvable from the project root`);
      const scanned = scanJsx(ts, source, text).tokens;
      if (metrics) metrics.typescriptScans = (metrics.typescriptScans ?? 0) + 1;
      const all = generate(text, scanned);
      return all.map((m) => ({ ...m, mode: 'typescript-scanned' }));
    }
    let all;
    if (functions) all = generate(text);
    else {
      // Stripping shifts offsets: operator and body edits need distinct token views.
      const operators = lexFacts(stripped, null, metrics);
      const bodies = lexFacts(text, null, metrics);
      all = [...generateMutants(source, stripped, operators.tokens, operators.pairs),
        ...bodySites(source, text, bodies.tokens, bodies.pairs)];
    }
    return all.map((m) => ({ ...m, mode: 'typescript' }));
  }
  if (JSX_EXTENSIONS.has(ext)) {
    ts ??= projectTypeScript(root);
    if (!ts) return null;
    const scanned = scanJsx(ts, source, text).tokens;
    if (metrics) metrics.typescriptScans = (metrics.typescriptScans ?? 0) + 1;
    return generate(text, scanned).map((m) => ({ ...m, mode: 'jsx' }));
  }
  return generate(text);
}

export async function candidateValidity(root, items, metrics) {
  if (metrics) {
    metrics.validityCalls = (metrics.validityCalls ?? 0) + 1;
    metrics.validityItems = (metrics.validityItems ?? 0) + items.length;
  }
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

export async function enumerateSites({ root, lines, log, diagnostics = [], functions = false,
  facts = null, metrics }) {
  const skipped = new Map();
  const candidates = [];
  const stats = { generated: 0, logging: 0, outOfScope: 0 };
  for (const [source, wanted] of lines) {
    const ext = extname(source);
    if (![...JS_EXTENSIONS, ...TS_EXTENSIONS, ...JSX_EXTENSIONS].includes(ext)) {
      skipped.set(source, 'not a JavaScript or TypeScript source');
      continue;
    }
    let text, all, initial;
    try {
      const ts = JSX_EXTENSIONS.has(ext) ? projectTypeScript(root) : null;
      if (JSX_EXTENSIONS.has(ext) && !ts) throw new Error('typescript is not resolvable from the project root');
      initial = facts?.readInitial(source);
      text = initial ? initial.text : readFileSync(join(root, source), 'utf8');
      all = sourceMutants(root, source, text, ts, functions, metrics);
    } catch (error) {
      if (error instanceof SourceChangedError) throw error;
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
    try { probe = await candidateValidity(root, modes.map((mode) => ({ m: { mode, source }, text })), metrics); }
    catch (error) { skipped.set(source, String(error?.message ?? error)); continue; }
    const mode = modes.find((_, k) => probe.errors[k] === null);
    if (!mode) {
      skipped.set(source, 'the unmutated source does not parse');
      continue;
    }
    if (facts && all.some((m) => wanted.has(m.line) && !m.filtered))
      facts.retain(source, initial);
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
