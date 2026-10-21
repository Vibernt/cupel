// Files the CLI reads: the spec schemas (shipped in packages/cupel/schemas/, kept identical to
// spec/schemas/ by test/schemas-sync.test.mjs), JSON documents and cupel.json.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usage } from './errors.mjs';
import { gitRoot } from './git.mjs';

export const SCHEMA_DIR = fileURLToPath(new URL('../../schemas/', import.meta.url));

let cached = null;
/** { input, config, report } schemas, resolved relative to the package so they work installed too. */
export function loadSchemas() {
  if (!cached) {
    const read = (name) => JSON.parse(readFileSync(`${SCHEMA_DIR}${name}.schema.json`, 'utf8'));
    cached = { input: read('input'), config: read('config'), report: read('report') };
  }
  return cached;
}

/** Reads a JSON file; a missing or malformed file is a usage error (exit 2). */
export function readJson(path, what = 'file') {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw usage(`cannot read ${what} ${path}: ${e.code ?? e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw usage(`${what} ${path} is not valid JSON: ${e.message}`);
  }
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** The project root: the git root containing cwd, else cwd itself. */
export function projectRoot(cwd) {
  return gitRoot(cwd) ?? resolve(cwd);
}

/**
 * The raw config: `--config <file>` (which must exist), else `cupel.json` at the root, else {}.
 * The engine validates it and applies defaults.
 */
export function loadConfig(root, cwd, configOption) {
  if (configOption !== undefined) return readJson(resolve(cwd, configOption), 'config');
  const p = resolve(root, 'cupel.json');
  return existsSync(p) ? readJson(p, 'config') : {};
}
