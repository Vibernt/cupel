// Shared filename-only policy. Never open a suspected credential to classify it.
const directories = new Set([
  '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker',
  'credentials', 'secrets', 'secret', 'private-keys', 'private_keys',
]);
const configDirectories = new Set(['gcloud', 'gh', 'containers']);
const filenames = new Set([
  '.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk',
  'application_default_credentials.json', 'credentials.db', 'access_tokens.db',
]);
const privateFilename = name => {
  const lower = name.toLowerCase();
  return filenames.has(lower) || lower === '.env' || lower.startsWith('.env.') ||
    /^credentials.*\.json$/i.test(name) || /\.(?:pem|key|p12)$/i.test(name);
};
const privateDirectory = (parts, name) => directories.has(name.toLowerCase()) ||
  (parts.at(-1)?.toLowerCase() === '.config' && configDirectories.has(name.toLowerCase()));
const privatePath = value => {
  const parts = value.split(/[\\/]/);
  return parts.some((name, index) => privateFilename(name) || privateDirectory(parts.slice(0, index), name));
};
module.exports = {privateFilename, privateDirectory, privatePath};
