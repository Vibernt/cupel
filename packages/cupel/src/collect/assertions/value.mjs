// Snapshot values without invoking getters or toJSON. Functions deliberately lose identity.
import { createHash } from 'node:crypto';
export function fingerprint(value) {
  const seen = new Map();
  const visit = (v) => {
    if (v === null) return ['null'];
    const type = typeof v;
    if (type === 'function') return ['function', '[Function]'];
    if (type === 'undefined') return ['undefined'];
    if (type === 'string') return v.length > 256
      ? ['string-sha256', v.length, createHash('sha256').update(v, 'utf16le').digest('hex')] : ['string', v];
    if (type === 'number') return ['number', Object.is(v, -0) ? '-0' : String(v)];
    if (type === 'boolean' || type === 'bigint') return [type, String(v)];
    if (type === 'symbol') return ['symbol', v.description ?? null];
    if (seen.has(v)) return ['ref', seen.get(v)];
    seen.set(v, seen.size);
    if (v instanceof RegExp) {
      const get = (key) => Object.getOwnPropertyDescriptor(RegExp.prototype, key).get.call(v);
      const flags = [['hasIndices', 'd'], ['global', 'g'], ['ignoreCase', 'i'], ['multiline', 'm'], ['dotAll', 's'], ['unicode', 'u'], ['unicodeSets', 'v'], ['sticky', 'y']];
      return ['regexp', get('source'), flags.filter(([key]) => get(key)).map(([, flag]) => flag).join('')];
    }
    if (v instanceof Date) return ['date', String(Date.prototype.getTime.call(v))];
    if (v instanceof Map) return ['map', [...Map.prototype.entries.call(v)].map(([k, x]) => [visit(k), visit(x)])];
    if (v instanceof Set) return ['set', [...Set.prototype.values.call(v)].map(visit)];
    const descriptors = Object.getOwnPropertyDescriptors(v);
    const entries = Object.keys(descriptors).sort().map((k) => {
      const d = descriptors[k];
      return [k, 'value' in d ? visit(d.value) : ['accessor']];
    });
    return [Array.isArray(v) ? 'array' : 'object', entries];
  };
  return JSON.stringify(visit(value));
}
