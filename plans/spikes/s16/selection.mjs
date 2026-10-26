import { NODE_PROFILE, refuse, sorted } from '../s12b/evidence.mjs';

const source = path => /^src\/.+\.(?:[cm]?[jt]sx?|py)$/.test(path);
const testFile = path => /^tests\/(?:.+\.test\.[cm]?[jt]sx?|(?:.*\/)?test_.*\.py)$/.test(path);
const code = path => /\.(?:[cm]?[jt]sx?|py)$/.test(path);
const has = (map, path) => Object.hasOwn(map ?? {}, path) && Boolean(map[path]);

function dependency(channels, path) {
  if (['imports', 'reads', 'probes'].some(key => channels[key].includes(path))) return true;
  return channels.directories.some(dir => path === dir || path.startsWith(`${dir}/`));
}

function covered(input, owner, path) {
  return input.tests.some(test => test.file === owner && has(input.coverage.byTest?.[test.id], path)) ||
    has(input.coverage.byFile?.[owner], path) || has(input.coverage.setup?.[owner], path);
}

function applicationObserver(channels, profile) {
  if (profile === NODE_PROFILE) return channels.filesystemEvents.some(event =>
    event.origin !== 'loader' && ['reads', 'probes', 'directories'].includes(event.channel));
  return channels.reads.length || channels.probes.length || channels.directories.length;
}

/** S12b selection after the coordinator has validated the baseline and captured the head. */
export function selectVerifiedHead(bundle, snapshot) {
  const head = snapshot.inventory;
  if (bundle.binding.opaqueRootNpmrc !== snapshot.opaqueRootNpmrc)
    return refuse('opaque root .npmrc presence differs between baseline and head');
  const base = bundle.core.identity.files;
  const changed = sorted(new Set([...Object.keys(base), ...Object.keys(head)]
    .filter(path => base[path] !== head[path])));
  const critical = new Set(bundle.core.criticalFiles);
  const selected = new Set(critical);
  const nonCode = [];
  for (const path of changed) {
    if (testFile(path)) {
      if (!head[path]) return refuse(`removed or renamed test file: ${path}`);
      if (critical.has(path)) return refuse(`changed critical test file requires head identity check: ${path}`);
      selected.add(path);
      continue;
    }
    if (source(path)) {
      if (!base[path] || !head[path]) return refuse(`new, removed or renamed source: ${path}`);
      if (!bundle.core.input.sources[path]) return refuse(`unknown source: ${path}`);
      continue;
    }
    if (code(path)) return refuse(`unsupported code path: ${path}`);
    nonCode.push(path);
  }
  if (nonCode.length) return { kind: 'full', reason: `D16 non-code full route: ${nonCode.join(', ')}`,
    files: sorted(Object.keys(head).filter(testFile)), changed };

  const changedSources = changed.filter(source);
  const allFiles = Object.keys(bundle.sidecar.files);
  const profile = bundle.sidecar.execution.isolation;
  if (changed.length && changed.every(path => code(path)) &&
    applicationObserver(bundle.sidecar.global, profile))
    for (const owner of allFiles) selected.add(owner);
  for (const path of changedSources) {
    let found = false;
    if (dependency(bundle.sidecar.global, path)) {
      for (const owner of allFiles) selected.add(owner);
      found = true;
    }
    for (const owner of allFiles) {
      const channels = bundle.sidecar.files[owner];
      if (covered(bundle.core.input, owner, path) || dependency(channels, path)) {
        selected.add(owner); found = true;
      }
    }
    if (!found) return refuse(`changed source has no proven dependent: ${path}`);
  }
  if (changed.length && changed.every(path => code(path)))
    for (const [owner, channels] of Object.entries(bundle.sidecar.files))
      if (applicationObserver(channels, profile)) selected.add(owner);
  if (!selected.size) return refuse('empty selection has no proof of safety');
  for (const path of selected) if (!head[path]) return refuse(`selected test file missing: ${path}`);
  return { kind: 'selected', reason: changed.length ? `changed: ${changed.join(', ')}` : 'clean control',
    files: sorted(selected), changed };
}
