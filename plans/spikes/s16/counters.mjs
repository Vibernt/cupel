import { lstatSync } from 'node:fs';
import { join } from 'node:path';

export function inventoryMetadata(root, fileMap) {
  let bytes = 0;
  const paths = Object.keys(fileMap ?? {});
  for (const name of paths) {
    if (name === '.npmrc' || name.startsWith('node_modules/') || name.startsWith('/') ||
      name.split('/').some(part => !part || part === '.' || part === '..'))
      throw new Error('S16 safe inventory path invalid or opaque');
    const stat = lstatSync(join(root, name));
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('S16 inventory metadata is not a regular file');
    bytes += stat.size;
  }
  return { files: paths.length, bytes };
}

export function summarizeFsCounters(counters) {
  const calls = counters.calls ?? {};
  const total = suffix => Object.entries(calls).filter(([key]) => key.endsWith(`:${suffix}`))
    .reduce((sum, [, value]) => sum + value, 0);
  const metadataCalls = ['readdirSync', 'lstatSync', 'statSync', 'realpathSync',
    'promiseReaddir', 'promiseLstat', 'promiseStat', 'promiseRealpath']
    .reduce((sum, method) => sum + total(method), 0);
  return {
    metadataCalls,
    directoryScans: total('readdirSync') + total('promiseReaddir'),
    fileReads: total('readFileSync') + total('readFile') + total('promiseReadFile'),
    returnedBytes: counters.readBytes ?? {},
    lockfileReads: (calls['baseLockfile:readFileSync'] ?? 0) +
      (calls['headLockfile:readFileSync'] ?? 0),
    dependencyReads: (calls['baseDependencies:readFileSync'] ?? 0) +
      (calls['headDependencies:readFileSync'] ?? 0),
    trustedRuntimeReads: (calls['trustedProfile:readFileSync'] ?? 0) +
      (calls['coordinator:readFileSync'] ?? 0) +
      (calls['transitiveProducer:readFileSync'] ?? 0),
  };
}
