import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validate } from '../engine/schema.mjs';

const schema = JSON.parse(readFileSync(new URL('../../schemas/config.schema.json', import.meta.url)));
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Admit only configuration that this Node profile actually executes. */
export function assertSupportedNodeProfileConfig(config) {
  const errors = validate(schema, config);
  if (errors.length)
    throw new Error(`Node PR configuration schema invalid: ${JSON.stringify(errors)}`);
  const runners = config.runners ?? {};
  if (Object.keys(runners).some(name => name !== 'node'))
    throw new Error('Node PR profile refuses configured non-node runners');
  if (Object.keys(runners.node ?? {}).some(key => key !== 'tests'))
    throw new Error('Node PR profile refuses unsupported node runner command, collector or override');
  if (config.mutation?.critical === false || config.mutation?.changedLines === false ||
      config.mutation?.targeted === false)
    throw new Error('Node PR profile refuses disabled critical, changed-line or targeted mutation');
  return config;
}

/** Bind caller config to declared, already privacy-checked repository bytes. */
export function assertDeclaredNodeProfileConfig(root, manifest, config) {
  assertSupportedNodeProfileConfig(config);
  if (!Object.hasOwn(manifest, 'cupel.json')) {
    if (!isDeepStrictEqual(config, {}))
      throw new Error('Node PR supplied configuration has no declared cupel.json');
    return config;
  }
  const bytes = readFileSync(join(root, 'cupel.json'));
  if (sha(bytes) !== manifest['cupel.json'])
    throw new Error('Node PR declared configuration bytes changed');
  let declared;
  try { declared = JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`Node PR declared configuration malformed: ${error.message}`); }
  assertSupportedNodeProfileConfig(declared);
  if (!isDeepStrictEqual(config, declared))
    throw new Error('Node PR supplied configuration differs from declared cupel.json');
  return config;
}
