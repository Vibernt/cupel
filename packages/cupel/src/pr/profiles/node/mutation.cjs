const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');
const { emit, deny, root } = require('./policy.cjs');

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Read once, before filesystem hooks and loader lockdown. Nothing is left in stdin. */
function startupMutation() {
  if (!process.env.CUPEL_MUTATION_PIPE) return null;
  if (process.env.CUPEL_MUTATION_PIPE !== 'stdin-v1') deny('mutation-pipe', 'unsupported pipe version');
  let value;
  try { value = JSON.parse(fs.readFileSync(0, 'utf8')); }
  catch (error) { deny('mutation-pipe', `invalid startup payload: ${error.message}`); }
  const source = value?.source;
  if (value?.version !== 'cupel-node-mutation-pipe/1' ||
      typeof source !== 'string' || source.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) ||
      !/^sha256:[0-9a-f]{64}$/.test(value.originalHash) ||
      !/^sha256:[0-9a-f]{64}$/.test(value.replacementHash) ||
      typeof value.replacementText !== 'string' ||
      Buffer.byteLength(value.replacementText) > 32 << 20 ||
      !value.mutant || typeof value.mutant.id !== 'string' ||
      value.mutant.source !== source || !Number.isSafeInteger(value.mutant.line) ||
      !value.url?.startsWith('file:') ||
      fileURLToPath(value.url) !== path.join(root, source) ||
      digest(value.replacementText) !== value.replacementHash)
    deny('mutation-pipe', 'startup payload failed identity checks');
  const raw = fs.readFileSync(path.join(root, source));
  if (digest(raw) !== value.originalHash) deny('mutation-source-changed', source);
  return Object.freeze(value);
}

module.exports = { startupMutation };
