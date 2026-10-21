#!/usr/bin/env node
// Repository rule checks (AGENTS.md). Run with `npm run check`; CI runs it on every push.
//  1. No network: shipped code never imports network modules or calls fetch.
//  2. Determinism and purity: the engine never reads the clock, uses unseeded randomness,
//     or imports runtime APIs (node:*, process), so the same engine runs in the CLI and in
//     Vibernt Assay on Cloudflare Workers.
//  3. Dependencies: exact versions only, each one named in plans/DECISIONS.md.
//  4. Still private: npm packages are "private": true; the Python package carries
//     the "Private :: Do Not Upload" classifier. Lifting either needs the owner (L6).

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const JS_NETWORK = [
  /\bfrom\s+['"](node:)?(http|https|http2|net|tls|dgram|dns)['"]/,
  /\brequire\(\s*['"](node:)?(http|https|http2|net|tls|dgram|dns)['"]\s*\)/,
  /\bimport\(\s*['"](node:)?(http|https|http2|net|tls|dgram|dns)['"]\s*\)/,
  /['"](undici|axios|node-fetch|got|ws)['"]/,
  /\bfetch\s*\(/,
  /\bnew\s+WebSocket\b/,
];
const PY_NETWORK = [
  /^\s*(import|from)\s+(socket|ssl|urllib|http|requests|httpx|aiohttp|ftplib|smtplib)\b/m,
];
const JS_NONDETERMINISM = [
  /\bDate\.now\s*\(/,
  /\bnew\s+Date\s*\(\s*\)/,
  /\bMath\.random\s*\(/,
  /\bperformance\.now\s*\(/,
  /\bprocess\.hrtime\b/,
  /\bcrypto\.random/,
  /\brandomUUID\s*\(/,
];
const JS_ENGINE_IMPURE = [
  /\bfrom\s+['"]node:/,
  /\bimport\(\s*['"]node:/,
  /\brequire\s*\(/,
  /\bprocess\./,
];

export { JS_ENGINE_IMPURE };

export function findViolations(text, patterns) {
  const hits = [];
  const lines = text.split('\n');
  for (const re of patterns) {
    lines.forEach((line, i) => {
      if (/cupel-allow-network|cupel-allow-nondeterminism/.test(line)) return;
      if (re.test(line)) hits.push({ line: i + 1, pattern: re.source, text: line.trim() });
    });
  }
  return hits;
}

export function checkDependencies(pkg, decisionsText) {
  const problems = [];
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (!/^\d+\.\d+\.\d+$/.test(range)) problems.push(`${field}.${name}: "${range}" is not an exact version`);
      if (!decisionsText.includes(name)) problems.push(`${field}.${name}: not justified in plans/DECISIONS.md`);
    }
  }
  return problems;
}

function walk(dir, exts) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name === '__pycache__' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

export function runChecks(root = ROOT) {
  const errors = [];
  const report = (file, hits, what) =>
    hits.forEach((h) => errors.push(`${relative(root, file)}:${h.line}: ${what}: ${h.text}`));

  for (const f of walk(join(root, 'packages/cupel/src'), ['.mjs', '.js', '.cjs']).concat(
    walk(join(root, 'packages/cupel/bin'), ['.mjs', '.js', '.cjs']),
  )) {
    report(f, findViolations(readFileSync(f, 'utf8'), JS_NETWORK), 'network call');
  }
  for (const f of walk(join(root, 'packages/cupel-py/src'), ['.py'])) {
    report(f, findViolations(readFileSync(f, 'utf8'), PY_NETWORK), 'network call');
  }
  for (const f of walk(join(root, 'packages/cupel/src/engine'), ['.mjs', '.js', '.cjs'])) {
    const text = readFileSync(f, 'utf8');
    report(f, findViolations(text, JS_NONDETERMINISM), 'clock or randomness in engine');
    report(f, findViolations(text, JS_ENGINE_IMPURE), 'runtime API in engine (engine must be pure)');
  }

  const decisions = readFileSync(join(root, 'plans/DECISIONS.md'), 'utf8');
  for (const p of ['package.json', 'packages/cupel/package.json']) {
    const pkg = JSON.parse(readFileSync(join(root, p), 'utf8'));
    if (pkg.private !== true) errors.push(`${p}: must stay "private": true until the owner approves publishing (L6)`);
    checkDependencies(pkg, decisions).forEach((m) => errors.push(`${p}: ${m}`));
  }
  const pyproject = readFileSync(join(root, 'packages/cupel-py/pyproject.toml'), 'utf8');
  if (!pyproject.includes('"Private :: Do Not Upload"')) {
    errors.push('packages/cupel-py/pyproject.toml: missing "Private :: Do Not Upload" classifier (L6)');
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = runChecks();
  if (errors.length) {
    process.stderr.write(`check: ${errors.length} problem(s)\n${errors.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('check: ok\n');
  }
}
