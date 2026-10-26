import { cmp } from '../../../engine/order.mjs';
import { isAbsolute, sep } from 'node:path';

const channels = ['imports', 'reads', 'probes', 'directories', 'writes'];
const filesystem = new Set(['reads', 'probes', 'directories', 'writes']);
const safePath = path => typeof path === 'string' && path &&
  !path.startsWith('/') && !path.includes('\\') &&
  path.split('/').every(part => part && part !== '.' && part !== '..');

/** Preserve only validated repository-relative observations needed for selection. */
export function profileTraceEvidence(traceRows, { privateTmp } = {}) {
  if (!Array.isArray(traceRows) || traceRows[0]?.kind !== 'bootstrap-ready' ||
      traceRows.at(-1)?.kind !== 'bootstrap-exit')
    throw new Error('Node PR trace boundary missing');
  const found = Object.fromEntries(channels.map(channel => [channel, new Set()]));
  const filesystemEvents = [];
  for (const row of traceRows) {
    const channel = row.channel === 'repository-read' ? 'reads' : row.channel;
    if (!channels.includes(channel)) continue;
    const path = row.file === '' && ['directories', 'probes'].includes(channel) ? '.' : row.file;
    if (isAbsolute(path ?? '')) {
      if (privateTmp && (path === privateTmp || path.startsWith(`${privateTmp}${sep}`)))
        continue;
      throw new Error('Node PR trace observed an external absolute path');
    }
    if ((path !== '.' && !safePath(path)) || typeof row.kind !== 'string' || !row.kind)
      throw new Error('Node PR trace path or operation invalid');
    if (filesystem.has(channel)) {
      if (!['loader', 'application', 'unknown'].includes(row.origin))
        throw new Error('Node PR filesystem invocation provenance missing');
      filesystemEvents.push({ channel, path,
        operation: row.kind, origin: row.origin });
    }
    found[channel].add(path);
  }
  if (found.writes.size) throw new Error('Node PR trace contains repository writes');
  return { ...Object.fromEntries(channels.map(channel =>
    [channel, [...found[channel]].sort(cmp)])), filesystemEvents };
}
