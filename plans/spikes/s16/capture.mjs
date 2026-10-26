import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { NODE_PROFILE } from '../s12b/evidence.mjs';

const PROFILE = resolve(fileURLToPath(new URL('../s12b/node-profile/', import.meta.url)));
const CAPABILITIES = ['module-linkage', 'fs-sync', 'fs-async', 'fs-stream',
  'fs-descriptor', 'metadata', 'directory', 'readonly-boundary',
  'unsupported-controls', 'fs-invocation-origin'];
const channels = () => ({ imports: [], reads: [], probes: [], directories: [], writes: [],
  filesystemEvents: [], capabilities: [], unsupported: [] });
const unique = values => [...new Set(values)].sort();

function parseRows(output, root) {
  const events = output.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const counts = new Map(); const rows = [];
  for (const event of events) {
    if (!['test:pass', 'test:fail'].includes(event.type) || event.data.details?.type === 'suite') continue;
    const file = relative(root, event.data.file ?? '').split(sep).join('/');
    if (!file || file.startsWith('../')) throw new Error('test result lacks repository file identity');
    const key = `${file}:${event.data.name}`;
    const ordinal = (counts.get(key) ?? 0) + 1;
    counts.set(key, ordinal);
    rows.push({ file, id: `${event.data.name}#${ordinal}`,
      status: event.data.skip || event.data.todo ? 'skipped' :
        event.type === 'test:fail' ? 'failed' : 'passed' });
  }
  if (!events.some(event => event.type === 'test:plan') || !rows.length)
    throw new Error('missing or incomplete test result stream');
  return rows;
}

/** Run the unchanged S12b hook once per selected file, serially. No full oracle. */
export function executeSelectedHead({ root, files, fullFiles, out, nodePath, pre,
  baselineConfigHash, headEnvironmentPolicyHash, producer, producerHash }) {
  root = resolve(root); out = resolve(out);
  if (out === root || out.startsWith(root + sep))
    throw new Error('private output must be outside fixture root');
  mkdirSync(out, { recursive: true });
  if (realpathSync(root) !== root || realpathSync(out) !== out)
    throw new Error('node profile refuses symlinked root or output');
  for (const file of fullFiles) if (!(file in pre.manifest))
    throw new Error(`missing original test file: ${file}`);
  for (const file of files) if (!(file in pre.manifest))
    throw new Error(`missing declared test file: ${file}`);

  const sidecar = { version: 'cupel-pr-dependencies/1',
    runner: { name: 'node', version: pre.environmentPolicy.version },
    runtime: { name: 'node', version: pre.environmentPolicy.version },
    execution: { mode: 'selected-head', isolation: NODE_PROFILE, profile: NODE_PROFILE,
      inputPolicy: pre.inputPolicy, opaqueRootNpmrc: pre.opaqueRootNpmrc,
      configHash: pre.identity.configHash,
      environmentPolicyHash: headEnvironmentPolicyHash,
      inputManifestHash: pre.identity.inputManifestHash,
      dependencyLockHash: pre.identity.dependencyLockHash,
      profileRuntimeHash: producerHash,
      baselineConfigHash, baselineProfileRuntimeHash: pre.runtimeHash,
      producer },
    files: {}, global: channels(), denials: [], nativeTypeScript: { files: {} },
    fullReferenceGuard: null,
    completion: { expectedFiles: [...files].sort(), finishedFiles: [], errors: [] } };
  const timings = []; const rows = [];
  for (const file of files) {
    const tmp = join(out, file.replaceAll('/', '_'));
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'events.jsonl'), '');
    const env = { CI: '1', NO_COLOR: '1', TZ: 'UTC', LANG: 'C',
      HOME: tmp, TMPDIR: tmp, CUPEL_ROOT: root, CUPEL_OWNER: file,
      CUPEL_INPUT_POLICY: pre.inputPolicy,
      CUPEL_INPUTS: JSON.stringify(Object.keys(pre.manifest)), CUPEL_PRIVATE_TMP: tmp,
      CUPEL_LOCKED_PACKAGES: JSON.stringify(Object.keys(pre.dependencyLock.packages)) };
    const args = ['--permission', `--allow-fs-read=${root}`, `--allow-fs-read=${PROFILE}`,
      `--allow-fs-read=${tmp}`, `--allow-fs-write=${tmp}`,
      `--require=${join(PROFILE, 'bootstrap.cjs')}`, '--test',
      '--experimental-test-isolation=none', `--test-reporter=${join(PROFILE, 'reporter.mjs')}`, file];
    const start = performance.now();
    const result = spawnSync(nodePath, args, { cwd: root, env, encoding: 'utf8',
      timeout: 30_000, maxBuffer: 8 << 20 });
    const ms = Math.round(performance.now() - start);
    timings.push({ file, ms, exit: result.status });
    writeFileSync(join(tmp, 'runner.out'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    const entry = channels(); sidecar.files[file] = entry;
    if (/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|ERR_UNKNOWN_FILE_EXTENSION/
      .test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`))
      entry.unsupported.push('unsupported-native-typescript-syntax');
    let events = [];
    try { events = readFileSync(join(tmp, 'events.jsonl'), 'utf8').split('\n')
      .filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { sidecar.completion.errors.push(`${file}: unreadable or malformed hook trace: ${error.message}`); }
    if (events[0]?.kind !== 'bootstrap-ready' || events.at(-1)?.kind !== 'bootstrap-exit')
      sidecar.completion.errors.push(`${file}: missing or truncated profile hook trace`);
    for (const event of events) {
      if (event.channel === 'control') continue;
      if (event.kind === 'unsupported') {
        const marker = `${event.reason}:${event.detail}`;
        entry.unsupported.push(marker); sidecar.denials.push({ file, marker }); continue;
      }
      const channel = event.channel === 'imports' ? 'imports' :
        event.channel === 'directories' ? 'directories' :
        event.channel === 'probes' ? 'probes' :
        event.channel === 'writes' ? 'writes' : 'reads';
      if (event.file && event.file !== PROFILE && !event.file.startsWith(PROFILE + sep) &&
          !event.file.startsWith(tmp)) {
        entry[channel].push(event.file);
        if (channel !== 'imports') entry.filesystemEvents.push({ channel, path: event.file,
          operation: event.kind, origin: event.origin ?? 'unknown' });
      }
    }
    for (const key of ['imports', 'reads', 'probes', 'directories', 'writes', 'unsupported'])
      entry[key] = unique(entry[key]);
    try {
      const found = parseRows(result.stdout, root);
      if (found.some(row => row.file !== file)) throw new Error('foreign file result');
      rows.push(...found); sidecar.completion.finishedFiles.push(file);
    } catch (error) { sidecar.completion.errors.push(`${file}: ${error.message}; exit ${result.status}`); }
    entry.capabilities = unique([...CAPABILITIES,
      entry.imports.some(path => /\.(?:ts|mts|cts)$/.test(path)) && 'native-typescript',
      [...entry.imports, ...entry.reads, ...entry.probes]
        .some(path => path.startsWith('node_modules/')) && 'locked-pure-js',
    ].filter(Boolean));
  }
  sidecar.completion.finishedFiles.sort();
  return { sidecar, timings, ordinaryFull: null, constrainedFull: { rows, parity: null },
    selectedHead: { rows, ms: timings.reduce((sum, row) => sum + row.ms, 0) } };
}
