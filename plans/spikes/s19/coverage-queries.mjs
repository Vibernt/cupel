import assert from 'node:assert/strict';

export const ranges = text => {
  const out = text.split(',').flatMap(part => {
    if (!part) return [];
    const [start, end = start] = part.split('-').map(Number);
    assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start);
    return [[start, end]];
  });
  for (let i = 1; i < out.length; i++)
    assert.ok(out[i][0] > out[i - 1][1], 'saved ranges overlap or are unordered');
  return out;
};

/** Round-robin distinct covered-and-coverable queries; each appears at most once. */
export function coverageQueries(input, cap = 200) {
  assert.ok(Number.isSafeInteger(cap) && cap > 0);
  const sourceFiles = Object.keys(input.sources).sort();
  const inventory = sourceFiles.map(source => ({ source,
    ranges: ranges(input.sources[source].coverable) }));
  const totalAvailableUnique = inventory.reduce((sum, entry) => sum +
    entry.ranges.reduce((value, [start, end]) => value + end - start + 1, 0), 0);
  const covered = new Map(sourceFiles.map(source => [source, new Set()]));
  const bySource = new Map(inventory.map(entry => [entry.source, entry.ranges]));
  for (const channel of [input.coverage.byTest, input.coverage.setup, input.coverage.byFile]) {
    for (const entry of Object.values(channel ?? {})) {
      for (const [source, text] of Object.entries(entry)) {
        const own = bySource.get(source);
        if (!own) continue;
        for (const [a, b] of ranges(text)) {
          for (const [c, d] of own) {
            for (let line = Math.max(a, c); line <= Math.min(b, d); line++)
              covered.get(source).add(line);
          }
        }
      }
    }
  }
  const rows = inventory.map(entry => ({ source: entry.source,
    lines: [...covered.get(entry.source)].sort((a, b) => a - b), at: 0 }));
  const coveredAvailableUnique = rows.reduce((sum, entry) => sum + entry.lines.length, 0);
  assert.ok(coveredAvailableUnique > 0, 'saved input has no covered coverable query');
  const queries = [];
  while (queries.length < Math.min(cap, coveredAvailableUnique)) {
    let added = 0;
    for (const entry of rows) {
      if (queries.length >= cap) break;
      if (entry.at < entry.lines.length) {
        queries.push({ source: entry.source, line: entry.lines[entry.at++] });
        added++;
      }
    }
    if (!added) break;
  }
  assert.equal(new Set(queries.map(q => `${q.source}\0${q.line}`)).size, queries.length);
  return { sourceCount: sourceFiles.length, totalAvailableUnique,
    coveredAvailableUnique, queries };
}
