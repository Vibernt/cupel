// Config defaults, read from config.schema.json itself (SPEC 2, 16). Pure.

function deref(root, schema) {
  while (schema && schema.$ref) {
    let node = root;
    for (const part of schema.$ref.slice(2).split('/')) node = node[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    schema = node;
  }
  return schema;
}

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function withDefaults(root, schema, value) {
  schema = deref(root, schema);
  if (!schema || !schema.properties || value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = { ...value };
  for (const [key, sub] of Object.entries(schema.properties)) {
    const s = deref(root, sub);
    if (out[key] === undefined) {
      if ('default' in s) out[key] = clone(s.default);
      else if (s.properties) out[key] = withDefaults(root, s, {});
    } else if (s.properties) {
      out[key] = withDefaults(root, s, out[key]);
    }
  }
  return out;
}

/** The config with every schema default applied, plus the effective word lists (D4). */
export function effectiveConfig(config, configSchema) {
  const c = withDefaults(configSchema, configSchema, config ?? {});
  return {
    ...c,
    words: {
      path: [...c.tiers.pathWords, ...c.tiers.extraPathWords],
      title: [...c.tiers.titleWords, ...c.tiers.extraTitleWords],
    },
  };
}
