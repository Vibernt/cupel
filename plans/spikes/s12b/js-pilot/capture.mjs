import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const unique = values => [...new Set(values)].sort();
const channels = () => ({ imports:[], reads:[], probes:[], directories:[], writes:[], capabilities:[], unsupported:[] });
const classOf = row => row.kind.includes('resolve') && row.kind !== 'realpathSync' && row.kind !== 'realpathSync.native' ? 'imports' :
  /(?:readFile|ReadStream|^open)/.test(row.kind) ? 'reads' :
    /(?:readdir|opendir)/.test(row.kind) ? 'directories' :
      /(?:write|append|WriteStream|rename|unlink|mkdir)/.test(row.kind) ? 'writes' : 'probes';

function argsFor(runner, root, file) {
  if (runner === 'node') return ['--test', '--test-reporter=dot', file];
  if (runner === 'vitest') return [join(root, 'node_modules/vitest/vitest.mjs'), 'run', file];
  if (runner === 'jest') return [join(root, 'node_modules/jest/bin/jest.js'), '--runInBand', '--no-cache', file];
  throw new Error(`unsupported runner ${runner}`);
}

/** One fresh process per test file. Returns an honest experimental sidecar and raw artifact paths. */
export function captureJsDependencies({ runner, root, files, out, version, binding }) {
  root = resolve(root); out = resolve(out); mkdirSync(out, { recursive:true });
  const nodeOptions = `--require=${join(here, 'trace.cjs')} --import=${new URL('./register.mjs', import.meta.url).href}`;
  const policy = { CI:'1', NO_COLOR:'1', TZ:'UTC', LANG:'C', NODE_OPTIONS:nodeOptions };
  const configName = runner === 'vitest' ? 'vitest.config.mjs' : runner === 'jest' ? 'jest.config.cjs' : 'package.json';
  const sidecar = { version:'cupel-pr-dependencies/1', runner:{name:runner,version},
    runtime:{name:'node',version:process.versions.node},
    execution:{isolation:'experimental-fresh-process-per-file',
      configHash:binding?.configHash ?? hash(readFileSync(join(root,configName))),
      environmentPolicyHash:binding?.environmentPolicyHash ?? hash(JSON.stringify(policy))},
    files:{}, global:channels(), completion:{expectedFiles:[...files].sort(),finishedFiles:[],errors:[]} };
  const timings = [];
  for (const file of files) {
    const log = join(out, file.replaceAll('/', '_') + '.jsonl');
    writeFileSync(log, '');
    const tmp = join(out, 'tmp-' + file.replaceAll('/', '_'));
    mkdirSync(tmp, { recursive:true });
    const env = { ...policy, HOME:tmp, TMPDIR:tmp, CUPEL_TRACE_ROOT:root, CUPEL_TRACE_OWNER:file, CUPEL_TRACE_OUT:log };
    const start = performance.now();
    const result = spawnSync(process.execPath, argsFor(runner, root, file), { cwd:root, env, encoding:'utf8', timeout:30000, maxBuffer:8 << 20 });
    const traceMs = Math.round(performance.now() - start);
    const rows = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const entry = channels();
    const global = sidecar.global;
    for (const row of rows) {
      if (!row.file || !['present','absent','write'].includes(row.result)) continue;
      const kind = classOf(row);
      entry[kind].push(row.file);
      if (row.result === 'absent' && kind !== 'directories') entry.probes.push(row.file);
      if (!row.direct) global[kind].push(row.file);
    }
    for (const channel of ['imports','reads','probes','directories','writes']) {
      entry[channel] = unique(entry[channel]); global[channel] = unique(global[channel]);
    }
    entry.capabilities = unique([
      rows.some(row => ['esm-resolve','cjs-resolve'].includes(row.kind) && row.file?.startsWith('src/')) && 'module-linkage',
      rows.some(row => /Sync(?:\.native)?$/.test(row.kind)) && 'fs-sync',
      rows.some(row => row.kind.startsWith('promise.') || row.kind.startsWith('callback.')) && 'fs-async',
      rows.some(row => row.kind === 'createReadStream') && 'fs-stream',
      rows.some(row => /(?:stat|access|exists|realpath|readlink)/i.test(row.kind)) && 'metadata',
      rows.some(row => /(?:readdir|opendir)/i.test(row.kind)) && 'directory',
    ].filter(Boolean));
    if (entry.writes.length) entry.unsupported.push('repository-write');
    entry.unsupported.push('unproven:fd-symlink-outside-boundary-child-worker-native-custom-loader');
    sidecar.files[file] = entry;
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    writeFileSync(join(out, file.replaceAll('/', '_') + '.out'), output);
    if (result.status === 0) sidecar.completion.finishedFiles.push(file);
    else sidecar.completion.errors.push(`${file}: exit ${result.status}, ${result.error?.message ?? output.slice(-300)}`);
    timings.push({ file, traceMs, exit:result.status, events:rows.length });
  }
  sidecar.completion.finishedFiles.sort();
  sidecar.global.unsupported.push('unproven:unowned-setup-transform-observations-conservative');
  return { sidecar, timings };
}
