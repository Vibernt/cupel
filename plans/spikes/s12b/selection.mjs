import { safeFileInventory, safeInputSnapshot } from './evidence-base.mjs';
import { digest, NODE_PROFILE, OPAQUE_NPMRC_POLICY, opaqueReferenceGuardError,
  refuse, sorted, validateBundle, validateSidecar } from './evidence.mjs';

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

export function selectS12b({ bundle, headRoot, ...args }) {
  const error = validateBundle(bundle, args);
  if (error) return refuse(error);
  let head; let opaqueRootNpmrc;
  try {
    ({ files: head, opaqueRootNpmrc } = safeInputSnapshot(headRoot,
      { inputPolicy: args.inputPolicy }));
  } catch (cause) { return refuse(cause.message); }
  if (bundle.binding.opaqueRootNpmrc !== opaqueRootNpmrc)
    return refuse('opaque root .npmrc presence differs between baseline and head');
  const base = bundle.core.identity.files;
  const changed = sorted(new Set([...Object.keys(base), ...Object.keys(head)].filter(path => base[path] !== head[path])));
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
  // Code may change any app-level path a file reads or enumerates at runtime.
  if (changed.length && changed.every(path => code(path)))
    for (const [owner, channels] of Object.entries(bundle.sidecar.files))
      if (applicationObserver(channels, profile)) selected.add(owner);
  if (!selected.size) return refuse('empty selection has no proof of safety');
  for (const path of selected) if (!head[path]) return refuse(`selected test file missing: ${path}`);
  return { kind: 'selected', reason: changed.length ? `changed: ${changed.join(', ')}` : 'clean control',
    files: sorted(selected), changed };
}

export function assessHeadTrace({ decision, sidecar, headRoot, runner, runtime, config,
  runnerVersion, environmentPolicy, executionPolicy, inputPolicy, bundle, mode = 'baseline' }) {
  if (decision.kind === 'refuse') return refuse(decision.reason);
  if (executionPolicy === NODE_PROFILE && mode === 'selected-head') {
    if (!bundle?.sidecar || sidecar?.execution?.baselineConfigHash !==
      bundle.sidecar.execution?.configHash)
      return refuse('selected head baseline parity/config identity differs');
    if (sidecar.execution.environmentPolicyHash !== bundle.sidecar.execution.environmentPolicyHash ||
      sidecar.execution.profileRuntimeHash !== bundle.sidecar.execution.profileRuntimeHash ||
      sidecar.execution.dependencyLockHash !== bundle.sidecar.execution.dependencyLockHash)
      return refuse('selected head baseline runtime or lock identity differs');
    if (inputPolicy === OPAQUE_NPMRC_POLICY) {
      const baselineFiles = bundle.sidecar.completion?.expectedFiles ?? [];
      const guardError = opaqueReferenceGuardError(bundle.sidecar, baselineFiles);
      if (guardError || bundle.binding?.sidecar !== digest(bundle.sidecar) ||
        Object.values(bundle.sidecar.files ?? {}).some(row =>
          !row.capabilities?.includes('privacy-guarded-full')))
        return refuse('selected head baseline privacy guard proof differs');
    }
    for (const [path, hash] of Object.entries(sidecar.dependencies?.files ?? {}))
      if (bundle.sidecar.dependencies?.files?.[path] !== hash)
        return refuse(`selected head dependency differs or was unseen at baseline: ${path}`);
  }
  let inventory; let opaqueRootNpmrc;
  try { ({ files: inventory, opaqueRootNpmrc } = safeInputSnapshot(headRoot, { inputPolicy })); }
  catch (error) { return refuse(error.message); }
  if (bundle?.binding?.opaqueRootNpmrc !== undefined &&
    bundle.binding.opaqueRootNpmrc !== opaqueRootNpmrc)
    return refuse('selected head opaque root .npmrc presence differs');
  const error = validateSidecar(sidecar, { runner, runnerVersion, runtimeVersion: runtime,
    testFiles: decision.files, inventory, root: headRoot, isolation: executionPolicy,
    configHash: digest(config), environmentPolicyHash: digest(environmentPolicy),
    profileRuntimeHash: environmentPolicy.runtimeHash, inputPolicy, opaqueRootNpmrc, mode });
  if (error) return refuse(`head dependency trace: ${error}`);
  return { kind: 'accepted', files: decision.files, reason: 'selected head trace complete and supported' };
}

export function selectAcrossRunners(runs) {
  if (!Array.isArray(runs) || !runs.length) return refuse('no runner evidence');
  if (runs.some(run => run.executionPolicy === NODE_PROFILE) &&
    (runs.length !== 1 || runs[0].runner !== 'node' || runs[0].executionPolicy !== NODE_PROFILE))
    return refuse('node readonly profile cannot mix with another selective runner');
  const decisions = runs.map(selectS12b);
  const blocked = decisions.find(decision => decision.kind === 'refuse');
  if (blocked) return refuse(`cross-runner refusal: ${blocked.reason}`);
  let files = sorted(new Set(decisions.flatMap(decision => decision.files)));
  const full = decisions.find(decision => decision.kind === 'full');
  if (full) {
    try { files = sorted(new Set(runs.flatMap(run => Object.keys(safeFileInventory(run.headRoot,
      { inputPolicy: run.inputPolicy })).filter(testFile)))); }
    catch (error) { return refuse(error.message); }
    return { kind: 'full', files, reason: `cross-runner D16 full route: ${full.reason}`, decisions };
  }
  return { kind: 'selected', files, reason: 'union of supported runner selections', decisions };
}
