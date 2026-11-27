// The run proof of a mutant served through a loader. Cupel cannot see the code a loader hands to V8, so a served
// fault is not known to have run just because it was loaded: a loader can bypass the text Cupel serves (its own
// file read, as tsx's CommonJS handler does, or its own cache) or a chain can skip the loader (raw JSX or TypeScript
// then fails to parse, which would look like a catch). The served text therefore carries one extra statement, ahead
// of the module's code and after any directive prologue, on the first code line so no line moves: it appends
// `<mark> <pid>` to a file each time the module runs. The runner scores the fault only when every process that loaded
// it ran it as often, the run's own test process ran it, and no process compiled the file without it.

import { tokenize } from '../lang/js/lexer.mjs';

/** Where the proof goes: { at, lead } from the project's TypeScript (any JS/TS/JSX), or null when unknown. */
function placeWithTypeScript(ts, source, text) {
  const kind = /\.tsx$/.test(source) ? ts.ScriptKind.TSX : /\.jsx$/.test(source) ? ts.ScriptKind.JSX
    : /\.[cm]?ts$/.test(source) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const tree = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, false, kind);
  if (tree.parseDiagnostics.length) return null;
  const statements = tree.statements;
  let k = 0;
  while (k < statements.length && ts.isExpressionStatement(statements[k]) && ts.isStringLiteral(statements[k].expression)) k++;
  if (k > 0) return { at: statements[k - 1].end, lead: text[statements[k - 1].end - 1] !== ';' };
  return statements.length ? { at: statements[0].getStart(tree), lead: false } : { at: text.length, lead: true };
}

/** The same from the shared JavaScript lexer, for JavaScript and TypeScript without a resolvable typescript. */
function placeWithLexer(text) {
  let tokens;
  try { tokens = tokenize(text); } catch { return null; }
  if (!tokens.length) return { at: text.length, lead: true };
  let i = 0, place = null;
  // Directives: string statements first, each ended by `;` or by a line break before a word or another string.
  while (tokens[i]?.type === 'string') {
    const next = tokens[i + 1];
    if (next?.value === ';') { place = { at: next.end, lead: false }; i += 2; continue; }
    if (!next || (next.line > tokens[i].line && (next.type === 'name' || next.type === 'string'))) {
      place = { at: tokens[i].end, lead: true };
      i += 1;
      continue;
    }
    if (i === 0) return { at: tokens[0].start, lead: false }; // an expression that starts with a string
    break;
  }
  return place ?? { at: tokens[0].start, lead: false };
}

/**
 * Mutated text with the run proof added, or null when no safe place is found (the fault is then not marked).
 * `mark` must be plain ASCII so any transform keeps it as written; `ts` is the project's TypeScript, or null.
 */
export function markedSource(ts, source, text, { mark, ranPath }) {
  const place = ts ? placeWithTypeScript(ts, source, text) : placeWithLexer(text);
  if (!place) return null;
  const proof = `try{globalThis.process.getBuiltinModule("node:fs").appendFileSync(${JSON.stringify(ranPath)},"${mark} "+globalThis.process.pid+"\\n")}catch{}`;
  return `${text.slice(0, place.at)}${place.lead ? ';' : ''}${proof};${text.slice(place.at)}`;
}

/** Counts per process id of `<kind> <pid>` lines (or `<mark> <pid>` lines, counted under the mark) from byte `from`. */
export function eventsAfter(text, from) {
  const out = new Map();
  for (const line of text.slice(from).split('\n')) {
    const [kind, pid] = line.trim().split(' ');
    if (!pid || !/^\d+$/.test(pid)) continue;
    if (!out.has(kind)) out.set(kind, new Map());
    out.get(kind).set(pid, (out.get(kind).get(pid) ?? 0) + 1);
  }
  return out;
}
