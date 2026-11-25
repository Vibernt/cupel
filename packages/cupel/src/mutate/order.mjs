// Deterministic test-file order for JavaScript faults. History and source/test
// proximity only move files ahead of the existing relevance/duration/path rule;
// they never add a file that coverage did not select.

import { cmp } from '../engine/order.mjs';

const OWN_DIRS = new Set(['__tests__', 'test', 'tests']);
const parts = (path) => String(path).replaceAll('\\', '/').split('/').filter(Boolean);

/** Whether `file` is an own-file test for `source` (for example src/a.ts -> tests/a.test.ts). */
export function isOwnTestFile(source, file) {
  const sourceParts = parts(source);
  const fileParts = parts(file);
  if (!sourceParts.length || !fileParts.length) return false;
  const sourceName = sourceParts.pop();
  const fileName = fileParts.pop();
  const dot = sourceName.lastIndexOf('.');
  const base = dot < 0 ? sourceName : sourceName.slice(0, dot);
  if (fileName !== `${base}.test.${fileName.split('.').at(-1)}` && fileName !== `${base}.spec.${fileName.split('.').at(-1)}`) return false;

  if (sourceParts.length === fileParts.length && sourceParts.every((part, i) => part === fileParts[i])) return true;
  // A test folder immediately inside the source folder: src/a/__tests__/b.spec.tsx.
  if (fileParts.length === sourceParts.length + 1 && OWN_DIRS.has(fileParts.at(-1)) &&
      sourceParts.every((part, i) => part === fileParts[i])) return true;
  // A sibling test tree that mirrors the source tree: src/a/b.ts -> test/a/b.test.mjs.
  if (fileParts.length !== sourceParts.length) return false;
  let replacements = 0;
  for (let i = 0; i < sourceParts.length; i++) {
    if (sourceParts[i] === fileParts[i]) continue;
    if (!OWN_DIRS.has(fileParts[i])) return false;
    replacements++;
  }
  return replacements === 1;
}

/**
 * @param {{
 *   counts: Map<string, number>,
 *   inputMs: (file: string) => number,
 *   source: string,
 *   previousCatchers?: string[],
 *   fileOfTest?: (testId: string) => string | undefined,
 * }} args
 * @returns {string[]} a permutation of the distinct selected files
 */
export function orderTestFiles({ counts, inputMs, source, previousCatchers = [], fileOfTest = () => undefined }) {
  const known = new Set(counts.keys());
  const placed = new Set();
  const out = [];
  const place = (file) => {
    if (!known.has(file) || placed.has(file)) return;
    placed.add(file);
    out.push(file);
  };
  const byInput = (a, b) => (counts.get(b) - counts.get(a)) || (inputMs(a) - inputMs(b)) || cmp(a, b);
  for (const id of previousCatchers) place(fileOfTest(id));
  for (const file of [...known].filter((item) => isOwnTestFile(source, item)).sort(byInput)) place(file);
  for (const file of [...known].filter((item) => !placed.has(item)).sort(byInput)) place(file);
  return out;
}
