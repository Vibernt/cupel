// The small part of the input model needed by mutation. Coverage remains in its compact input form
// until a selected site needs it; report-only unit signals and exclusive-line sweeps are not built.

import { isCriticalSource } from '../engine/model.mjs';
import { lines, mapFrom, mapUnionAll, mapUnion, mapDiff } from '../engine/lines.mjs';
import { cmp } from '../engine/order.mjs';
import { unitOf } from '../engine/integrity.mjs';

export function mutationModel(input, cfg, targetedIds = []) {
  const sources = new Map();
  for (const path of Object.keys(input.sources).sort(cmp)) {
    sources.set(path, { coverable: lines(input.sources[path].coverable), critical: isCriticalSource(path, cfg) });
  }

  const byTest = input.coverage.byTest ?? {};
  const setup = new Map(Object.entries(input.coverage.setup ?? {}));
  const byFile = new Map(Object.entries(input.coverage.byFile ?? {}));
  const rows = new Map([...targetedIds].map((id) => [id, []]));
  for (const test of input.tests) {
    const own = rows.get(unitOf(test));
    if (own) own.push(test);
  }
  const unitById = new Map();
  for (const [id, tests] of rows) {
    if (!tests.length) continue;
    const file = tests[0].file;
    const rowsCov = mapUnionAll(tests.map((test) => mapFrom(byTest[test.id])));
    const raw = input.coverage.granularity === 'file' ? mapUnion(rowsCov, mapFrom(input.coverage.byFile?.[file])) : rowsCov;
    unitById.set(id, { own: mapDiff(raw, mapFrom(input.coverage.setup?.[file])) });
  }
  return { sources, byTest, setup, byFile, unitById };
}
