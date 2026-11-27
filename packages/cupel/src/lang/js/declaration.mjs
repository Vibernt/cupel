// TypeScript declaration files (`x.d.ts`, `x.d.mts`, `x.d.cts`, and `x.d.css.ts` for arbitrary extensions) hold
// only types: nothing in them runs, so they are never sources and never count as uncovered code.

const DECLARATION = /\.d\.(?:[cm]?ts|[^/.]+\.ts)$/;

/** Whether `file` is a TypeScript declaration file. */
export function isDeclarationFile(file) {
  return DECLARATION.test(file);
}
