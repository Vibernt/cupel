// S10b only. Pure analysis of an unchanged Cupel input and its assertion sidecar.
const sort = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const assertionKey = (a) => JSON.stringify([a.matcher, a.subject, a.expectedFingerprint]);
export function inputIdentity(input) {
  return JSON.stringify({
    tests: input.tests.map((t) => [t.id, t.unit ?? t.id, t.status]).sort((a, b) => sort(a[0], b[0])),
    sources: Object.keys(input.sources ?? {}).sort(sort).map((f) => [f, input.sources[f].hash ?? null]),
    shapes: Object.keys(input.shapes ?? {}).sort(sort).map((id) => [id, [...input.shapes[id]].sort(sort)]),
  });
}
function similar(a, b) {
  if (!a?.length || !b?.length) return false;
  const x = new Set(a), y = new Set(b);
  const intersection = [...x].filter((s) => y.has(s)).length;
  return intersection * 10 >= (x.size + y.size - intersection) * 9;
}
export function analyseAssertions(input, sidecar) {
  if (sidecar?.version !== 'cupel-assertions/1' || sidecar.inputIdentity !== inputIdentity(input)) {
    throw new Error('assertion sidecar is unsupported or does not match the input');
  }
  const groups = new Map();
  for (const t of input.tests) {
    const id = t.unit ?? t.id;
    if (!groups.has(id)) groups.set(id, { id, tests: [], records: [], assertionCount: 0, capHit: false, incomplete: false, errors: [] });
    const u = groups.get(id), data = sidecar.tests[t.id];
    u.tests.push(t.id);
    if (!data || t.status !== 'passed') u.incomplete = true;
    if (!data) { u.errors.push(`missing recording: ${t.id}`); continue; }
    if (!Array.isArray(data.records) || !Number.isSafeInteger(data.count) || data.count < data.records.length) throw new Error(`invalid assertion recording: ${t.id}`);
    u.assertionCount += data.count;
    u.capHit ||= data.capHit;
    u.incomplete ||= !!data.incomplete || !!data.capHit;
    u.errors.push(...data.errors);
    u.records.push(...data.records);
  }
  const units = [...groups.values()].sort((a, b) => sort(a.id, b.id));
  const sets = new Map(units.map((u) => [u.id, new Set(u.records.map(assertionKey))]));
  const owners = new Map();
  for (const [id, keys] of sets) for (const key of keys) {
    if (!owners.has(key)) owners.set(key, new Set());
    owners.get(key).add(id);
  }
  return { kind: 'assertions', version: 'cupel-assertions/1', units: units.map((u) => {
    const keys = sets.get(u.id);
    const subsumedBy = [], cloneOf = [];
    if (!u.incomplete && keys.size) for (const v of units) {
      if (v === u || v.incomplete) continue;
      const other = sets.get(v.id);
      if (![...keys].every((k) => other.has(k))) continue;
      subsumedBy.push(v.id);
      if (keys.size === other.size && similar(input.shapes?.[u.id], input.shapes?.[v.id])) cloneOf.push(v.id);
    }
    return { ...u, tests: u.tests.sort(sort), errors: [...new Set(u.errors)].sort(sort),
      fingerprints: [...keys].sort(sort), uniqueFingerprints: [...keys].filter((k) => owners.get(k).size === 1).sort(sort),
      subsumedBy, cloneOf, assertionFree: u.incomplete ? null : u.records.every((a) => a.trivial === true) };
  }) };
}

// The identity-only projection of one runner from a merged input. It matches the
// reconstruction used by `cupel assertions --input`, without importing CLI I/O.
function runnerIdentityInput(input, runtime) {
  const tests = input.tests.filter((t) => t.runner === runtime.runner);
  const ids = new Set(tests.map((t) => t.id));
  const units = new Set(tests.map((t) => t.unit ?? t.id));
  const files = new Set(tests.map((t) => t.file));
  const selected = (obj, keys) => Object.fromEntries(Object.entries(obj ?? {}).filter(([key]) => keys.has(key)));
  const coverage = input.coverage;
  const covered = [selected(coverage.byTest, ids), selected(coverage.byFile, files), selected(coverage.setup, files)];
  const paths = new Set(covered.flatMap((part) => Object.values(part).flatMap(Object.keys)));
  const ext = runtime.name === 'node' ? /\.[cm]?[jt]sx?$/ : runtime.name === 'python' ? /\.py$/ :
    runtime.name === 'go' ? /\.go$/ : runtime.name === 'rust' ? /\.rs$/ : /\.rb$/;
  for (const path of Object.keys(input.sources)) if (ext.test(path)) paths.add(path);
  return { tests: tests.map(({ runner, ...test }) => test), sources: selected(input.sources, paths), shapes: selected(input.shapes, units) };
}

/** Accepts the raw S10b sidecar for one runner or the CLI's merged sidecar. */
export function analyseReviewAssertions(input, sidecar) {
  if (!input.runtimes) return analyseAssertions(input, sidecar).units;
  if (sidecar?.version !== 'cupel-assertions-multi/1' || !sidecar.runners ||
      typeof sidecar.runners !== 'object' || Array.isArray(sidecar.runners)) throw new Error('merged input needs a multi-runner assertion sidecar');
  const names = new Set(input.runtimes.map((r) => r.runner));
  for (const name of Object.keys(sidecar.runners)) if (!names.has(name)) throw new Error(`unknown assertion runner: ${name}`);
  return input.runtimes.flatMap((runtime) => sidecar.runners[runtime.runner]
    ? analyseAssertions(runnerIdentityInput(input, runtime), sidecar.runners[runtime.runner]).units : []);
}
