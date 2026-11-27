// The run proof of a JSX mutant. JSX runs only through the project's loader, and Cupel cannot see the code a loader
// hands to V8, so a served fault is not known to have run just because it was loaded: a loader can bypass the text
// Cupel serves (its own cache, its own file read) or a chain can skip the loader (the raw JSX then fails to parse,
// which would look like a catch). The served text therefore carries one extra statement, ahead of the module's
// code and after any directive prologue, on the first code line so no line moves: it appends `<mark> <pid>` to a
// file. A process that loaded the fault and never ran that statement did not run the fault, and the runner refuses
// the fault instead of scoring it.

/** Mutated JSX text with the run proof added; `mark` must be plain ASCII so any transform keeps it as written. */
export function markedSource(ts, source, text, { mark, ranPath }) {
  const kind = /\.tsx$/.test(source) ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
  const tree = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, false, kind);
  const statements = tree.statements;
  let k = 0;
  while (k < statements.length && ts.isExpressionStatement(statements[k]) && ts.isStringLiteral(statements[k].expression)) k++;
  const proof = `try{globalThis.process.getBuiltinModule("node:fs").appendFileSync(${JSON.stringify(ranPath)},"${mark} "+globalThis.process.pid+"\\n")}catch{}`;
  // After directives (which must stay first) or before the first statement (after leading comments and pragmas).
  const at = k > 0 ? statements[k - 1].end : statements.length ? statements[0].getStart(tree) : text.length;
  const lead = (k > 0 && text[at - 1] !== ';') || !statements.length ? ';' : '';
  const statement = `${lead}${proof};`;
  return text.slice(0, at) + statement + text.slice(at);
}

/** Process ids recorded in a seen file (`<pid>` lines) or a ran file (`<mark> <pid>` lines) from byte `from` on. */
export function pidsAfter(text, from) {
  const out = new Set();
  for (const line of text.slice(from).split('\n')) {
    const pid = line.trim().split(' ').at(-1);
    if (/^\d+$/.test(pid)) out.add(pid);
  }
  return out;
}
