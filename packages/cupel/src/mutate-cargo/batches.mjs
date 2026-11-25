/**
 * Stable Rust fault selectors and compilation batches.
 *
 * CI slices must share one switched build, so selectors and batches are derived
 * from the complete fault inventory before a slice is chosen. Consequently an
 * artifact or plan digest must describe that complete inventory, never the
 * slice that happens to execute it.
 *
 * Pure: these functions perform no I/O. Hashing is deterministic and is used
 * only to give selector sets and batch contents stable identities.
 */

import { createHash } from 'node:crypto';
import { cmp } from '../engine/order.mjs';
import { mutantId } from './import.mjs';

const U32_MAX = 0xffff_ffff;
const posix = (path) => path.replaceAll('\\', '/');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
}

/**
 * Assigns the complete cargo-mutants listing for `files` stable u32 selector
 * numbers. Selection, reuse and CI slicing happen after this map is made, so
 * the same fault keeps its switch number in every slice of one build.
 *
 * @param {Array<object>} listing cargo-mutants' `--list --json` result
 * @param {{ files: Iterable<string> }} options source files in the build
 * @returns {Map<string, number>} mutant id to positive u32 selector
 */
export function stableSelectors(listing, { files }) {
  const included = new Set([...files].map(posix));
  const ordered = listing
    .filter((mutant) => included.has(posix(mutant.file)))
    .map((mutant) => ({
      id: mutantId(mutant),
      source: posix(mutant.file),
      line: mutant.span.start.line,
      column: mutant.span.start.column,
    }))
    .sort((a, b) => cmp(a.source, b.source) || a.line - b.line || a.column - b.column || cmp(a.id, b.id));

  if (ordered.length > U32_MAX) throw new RangeError(`Rust fault selectors exceed u32 (${ordered.length})`);
  const selectors = new Map();
  ordered.forEach(({ id }, index) => {
    if (selectors.has(id)) throw new Error(`duplicate Rust mutant id: ${id}`);
    selectors.set(id, index + 1);
  });
  return selectors;
}

/**
 * Identifies the complete selector table used by a switched build. Pairs are
 * sorted by id so Map insertion order, and therefore a CI slice, cannot change
 * the artifact identity.
 *
 * @param {Map<string, number>} selectors
 * @returns {string} `sha256:` followed by a lowercase hexadecimal digest
 */
export function selectorDigest(selectors) {
  if (!(selectors instanceof Map)) throw new TypeError('selectors must be a Map');
  const pairs = [...selectors].map(([id, number]) => {
    if (typeof id !== 'string') throw new TypeError('selector ids must be strings');
    if (!Number.isInteger(number) || number < 1 || number > U32_MAX) throw new RangeError(`selector for ${id} must be a positive u32`);
    return [id, number];
  }).sort(([a], [b]) => cmp(a, b));
  return `sha256:${sha256(JSON.stringify(pairs))}`;
}

function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort(cmp).map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const functionKey = (fault) => fault.function
  ? stableValue({ name: fault.function.name, span: fault.function.span })
  : null;

const faultOrder = (a, b) => cmp(a.source, b.source)
  || a.line - b.line
  || cmp(functionKey(a) ?? '', functionKey(b) ?? '')
  || cmp(a.genre, b.genre)
  || cmp(a.id, b.id);

/**
 * Partitions the complete fault inventory into deterministic, single-source
 * compilation batches. No batch exceeds either limit. A function-less fault
 * counts only toward the batch-wide limit because it is not attributable to a
 * function.
 *
 * Batch keys hash their ordered contents rather than their position. This
 * gives a precise slice-stability guarantee: if every fault outside any one
 * emitted batch is removed, repartitioning returns that exact batch with the
 * same key and id order. Removing whole source files also leaves every batch
 * of the remaining files unchanged. Arbitrary partial inventories may pack
 * differently, so callers must partition all faults before selecting batches
 * for a CI slice; the plan digest must not be recomputed from a slice.
 *
 * @param {Array<{id: string, source: string, line: number, function?: {name: string, span: unknown}, genre: string}>} faults
 * @param {{ maxFaultsPerBatch?: number, maxPerFunction?: number }} options
 * @returns {Array<{key: string, faults: string[]}>}
 */
export function partitionBatches(faults, { maxFaultsPerBatch = 400, maxPerFunction = 8 } = {}) {
  positiveInteger(maxFaultsPerBatch, 'maxFaultsPerBatch');
  positiveInteger(maxPerFunction, 'maxPerFunction');

  const ordered = [...faults].sort(faultOrder);
  const ids = new Set();
  for (const fault of ordered) {
    if (ids.has(fault.id)) throw new Error(`duplicate Rust fault id: ${fault.id}`);
    ids.add(fault.id);
  }

  const output = [];
  for (let at = 0; at < ordered.length;) {
    const source = ordered[at].source;
    let end = at + 1;
    while (end < ordered.length && ordered[end].source === source) end++;
    const batches = [];
    for (const fault of ordered.slice(at, end)) {
      const fn = functionKey(fault);
      let batch = batches.find((candidate) => candidate.faults.length < maxFaultsPerBatch
        && (fn === null || (candidate.functions.get(fn) ?? 0) < maxPerFunction));
      if (!batch) {
        batch = { faults: [], functions: new Map() };
        batches.push(batch);
      }
      batch.faults.push(fault.id);
      if (fn !== null) batch.functions.set(fn, (batch.functions.get(fn) ?? 0) + 1);
    }
    for (const batch of batches) {
      const key = `${source}#${sha256(JSON.stringify(batch.faults))}`;
      output.push({ key, faults: batch.faults });
    }
    at = end;
  }
  return output;
}
