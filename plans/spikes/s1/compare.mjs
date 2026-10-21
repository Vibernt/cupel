/**
 * S1 spike, step 5: is per-file line coverage the same from one run to the next?
 *
 *   node plans/spikes/s1/compare.mjs <lines dir A> <lines dir B>
 *
 * Compares two directories of per-run line sets written by reduce.mjs (for example <out>/lines-cov and
 * <out>/rerun/lines-cov) and prints, as JSON: runs compared, runs whose line sets differ, lines only in A, lines
 * only in B, and the differing runs with their counts (largest first). Standard library only.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const [a, b] = process.argv.slice(2).map(p => resolve(p));
if (!a || !b) { console.error('usage: compare.mjs <lines dir A> <lines dir B>'); process.exit(2); }
const keys = file => {
    const out = new Set();
    for (const [p, ls] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) for (const l of ls) out.add(`${p}:${l}`);
    return out;
};
let onlyA = 0, onlyB = 0, compared = 0;
const differing = [];
for (const name of readdirSync(a).filter(f => f.endsWith('.json')).sort()) {
    if (!existsSync(resolve(b, name))) continue;
    const A = keys(resolve(a, name)), B = keys(resolve(b, name));
    let x = 0, y = 0;
    for (const k of A) if (!B.has(k)) x++;
    for (const k of B) if (!A.has(k)) y++;
    compared++; onlyA += x; onlyB += y;
    if (x || y) differing.push({ run: name.replace(/\.json$/, ''), onlyA: x, onlyB: y, sizeA: A.size });
}
differing.sort((p, q) => (q.onlyA + q.onlyB) - (p.onlyA + p.onlyB) || (p.run < q.run ? -1 : 1));
console.log(JSON.stringify({ compared, differingRuns: differing.length, linesOnlyInA: onlyA, linesOnlyInB: onlyB, differing }, null, 1));
