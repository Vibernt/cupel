import { createHash } from 'node:crypto';
import { refuse } from './errors.mjs';
export function sourceSites(inventory, source, lines) {
  const bytes = inventory.bytes(source);
  return inventory.parsed.get(source).sites.filter((site) => lines.has(site.line)).map((site) => {
    if (bytes.subarray(site.start,site.end).toString() !== site.original || Buffer.byteLength(site.original) !== Buffer.byteLength(site.replacement) || /[\r\n]/.test(site.replacement)) refuse('rust-sites','equal-width Rust source site invariant failed');
    const suffix = createHash('sha256').update(`${site.original}\0${site.replacement}`).digest('hex').slice(0,8);
    return { ...site, source, id: `${source}:${site.line}:${site.column}:${site.operator}:${suffix}` };
  }).sort((a,b) => a.start-b.start || a.id.localeCompare(b.id));
}
export function applyRustSite(bytes, site) { return Buffer.concat([bytes.subarray(0,site.start), Buffer.from(site.replacement), bytes.subarray(site.end)]); }
