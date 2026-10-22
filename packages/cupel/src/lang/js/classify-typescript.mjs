import { stripTypeScriptTypes } from 'node:module';
import { analyse } from '../../collect/node/lines.mjs';
import { projectTypeScript, scanJsx } from './project-typescript.mjs';

/** Preserve offsets when Node cannot strip syntax that requires a transform. */
export function classifyTypeScript(root, file, text) {
  let stripped;
  try {
    stripped = stripTypeScriptTypes(text);
  } catch (stripError) {
    let ts;
    try { ts = projectTypeScript(root); }
    catch (error) { throw new Error(`${stripError.message}; ${error.message}`); }
    if (!ts) throw new Error(`${stripError.message}; typescript is not resolvable from the project root`);
    const scanned = scanJsx(ts, file, text);
    return { text, analysis: scanned.analysis, tokens: scanned.tokens };
  }
  return { text: stripped, analysis: analyse(stripped, { strict: true }), tokens: null };
}
