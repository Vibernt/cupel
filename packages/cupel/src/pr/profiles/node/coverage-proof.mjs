/** Validate private coverage completion and reconcile actual leaf test rows. */
function intervals(value) {
  if (!Array.isArray(value) || value.length % 2 !== 0) return false;
  for (let index = 0; index < value.length; index += 2) {
    if (!Number.isSafeInteger(value[index]) || !Number.isSafeInteger(value[index + 1]) ||
        value[index] < 0 || value[index + 1] <= value[index] ||
        (index && value[index] < value[index - 1])) return false;
  }
  return true;
}

function evidenceMap(value, sources) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([source, ranges]) => sources.has(source) && intervals(ranges));
}

function union(a, b) {
  const intervals = [];
  for (const value of [a ?? [], b ?? []])
    for (let index = 0; index < value.length; index += 2)
      intervals.push([value[index], value[index + 1]]);
  intervals.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const result = [];
  for (const [start, end] of intervals) {
    const last = result.at(-1);
    if (last && last[1] >= start) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result.flat();
}

/** Returns raw intervals keyed by reporter leaf id, or throws a refusal reason. */
export function verifyCoverageProof(record, { file, inputManifestHash, rows, sources }) {
  if (!record || record.version !== 'cupel-node-coverage/1' || record.owner !== file ||
      record.inputManifestHash !== inputManifestHash ||
      !Array.isArray(record.errors) || record.errors.length ||
      !Array.isArray(record.tests) || !evidenceMap(record.setup, sources))
    throw new Error('per-test coverage header, source, or error proof differs');
  const bounds = record.boundaries;
  if (!bounds || bounds.before !== 1 || bounds.after !== 1 || bounds.exit !== 1 ||
      bounds.beforeEach !== record.tests.length || bounds.afterEach !== record.tests.length ||
      !Number.isSafeInteger(bounds.checkpoints) || bounds.checkpoints < record.tests.length * 2 + 3)
    throw new Error('per-test coverage boundaries did not complete');
  for (const test of record.tests) {
    if (typeof test.fullName !== 'string' || !test.fullName ||
        !Number.isSafeInteger(test.ordinal) || test.ordinal < 0 || test.completed !== true ||
        !evidenceMap(test.cov, sources))
      throw new Error('per-test coverage record invalid');
  }
  const leaves = record.tests.filter(test => !record.tests.some(other =>
    other !== test && other.fullName.startsWith(`${test.fullName} > `)));
  const executed = rows.filter(row => row.status !== 'skipped');
  if (leaves.length !== executed.length ||
      new Set(executed.map(row => row.id)).size !== executed.length ||
      leaves.some((test, index) => test.fullName !== executed[index].fullName ||
        test.ordinal !== executed[index].ordinal - 1))
    throw new Error('per-test coverage leaf identities differ from reporter');
  const byTest = {};
  for (let index = 0; index < leaves.length; index++) {
    const leaf = leaves[index];
    const parent = record.tests.filter(test => leaf.fullName.startsWith(`${test.fullName} > `));
    const merged = { ...leaf.cov };
    for (const test of parent) for (const [source, ranges] of Object.entries(test.cov))
      merged[source] = union(merged[source], ranges);
    byTest[executed[index].id] = merged;
  }
  return { byTest, setup: record.setup };
}
