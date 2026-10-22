// Enumerate mutation edit descriptors source by source, without retaining source texts.

import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { generateMutants } from './operators.mjs';
import { checkValidity } from './validity.mjs';

const JS_EXTENSIONS = new Set(['.mjs', '.js', '.cjs']);

export async function enumerateSites({ root, lines, log }) {
  const skipped = new Map();
  const candidates = [];
  const stats = { generated: 0, logging: 0, outOfScope: 0 };
  for (const [source, wanted] of lines) {
    if (!JS_EXTENSIONS.has(extname(source))) {
      skipped.set(source, 'not a JavaScript source');
      continue;
    }
    let text, all;
    try {
      text = readFileSync(join(root, source), 'utf8');
      all = generateMutants(source, text);
    } catch (error) {
      skipped.set(source, String(error?.message ?? error));
      continue;
    }
    const ext = extname(source);
    const modes = ext === '.mjs' ? ['module'] : ext === '.cjs' ? ['commonjs'] : ['module', 'commonjs'];
    const probe = await checkValidity(modes.map((mode) => ({ mode, text })));
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
