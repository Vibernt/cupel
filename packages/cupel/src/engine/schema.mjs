// A small JSON Schema validator for the subset of draft 2020-12 that the spec's schemas use.
// Pure: no I/O. Unknown keywords throw, so the schemas stay within a subset any validator handles.

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', 'default', '$defs']);
const KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'pattern',
  'minimum', 'maximum', 'minLength', 'minItems', '$ref', 'anyOf',
]);

const typeOf = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
};

const typeMatches = (want, v) => {
  const got = typeOf(v);
  return want === got || (want === 'number' && got === 'integer');
};

const pointer = (path) => (path.length ? '/' + path.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/') : '');

function resolve(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref: ${ref}`);
  let node = root;
  for (const part of ref.slice(2).split('/')) {
    node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) throw new Error(`unresolved $ref: ${ref}`);
  }
  return node;
}

function check(root, schema, value, path, errors) {
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) throw new Error(`unsupported schema keyword: ${key}`);
  }
  const fail = (message) => errors.push({ path: pointer(path), message });

  if (schema.$ref) return check(root, resolve(root, schema.$ref), value, path, errors);
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => {
      const sub = [];
      check(root, s, value, path, sub);
      return sub.length === 0;
    });
    if (!ok) fail('does not match any allowed form');
    return;
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    return fail(`must be ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    return fail(`must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) return fail(`must be ${types.join(' or ')}`);
  }
  const t = typeOf(value);
  if (t === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) fail(`must have at least ${schema.minLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) fail(`must match ${schema.pattern}`);
  }
  if (t === 'integer' || t === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`must be at most ${schema.maximum}`);
  }
  if (t === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`must have at least ${schema.minItems} items`);
    if (schema.items) value.forEach((v, i) => check(root, schema.items, v, [...path, i], errors));
  }
  if (t === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) fail(`missing required property "${key}"`);
    }
    for (const [key, v] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) {
        check(root, schema.properties[key], v, [...path, key], errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: pointer([...path, key]), message: 'is not allowed' });
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        check(root, schema.additionalProperties, v, [...path, key], errors);
      }
    }
  }
}

/** Validates `value` against `schema`. Returns a list of { path, message }, empty when valid. */
export function validate(schema, value) {
  const errors = [];
  check(schema, schema, value, [], errors);
  return errors;
}
