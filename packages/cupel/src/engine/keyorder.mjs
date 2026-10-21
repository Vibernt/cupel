// R1: object keys in the order the report schema lists them. Pure.
// Keys of map-like objects (additionalProperties schemas, such as lost.lines) are sorted by code point.

import { cmp } from './order.mjs';

function deref(root, schema) {
  while (schema && schema.$ref) {
    let node = root;
    for (const part of schema.$ref.slice(2).split('/')) node = node[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    schema = node;
  }
  return schema;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function pick(root, schema, value) {
  schema = deref(root, schema);
  if (!schema || !schema.anyOf) return schema;
  // The branch whose type fits the value.
  for (const s of schema.anyOf.map((x) => deref(root, x))) {
    if (value === null && s.type === 'null') return s;
    if (isObject(value) && (s.type === 'object' || s.properties)) return s;
    if (Array.isArray(value) && s.type === 'array') return s;
  }
  return null;
}

export function orderKeys(root, schema, value) {
  const s = pick(root, schema, value);
  if (Array.isArray(value)) return value.map((v) => orderKeys(root, s?.items, v));
  if (!isObject(value)) return value;
  const out = {};
  const props = s?.properties ?? {};
  for (const key of Object.keys(props)) if (value[key] !== undefined) out[key] = orderKeys(root, props[key], value[key]);
  const rest = Object.keys(value).filter((k) => !Object.hasOwn(props, k) && value[k] !== undefined).sort(cmp);
  const extra = s && isObject(s.additionalProperties) ? s.additionalProperties : undefined;
  for (const key of rest) out[key] = orderKeys(root, extra, value[key]);
  return out;
}
