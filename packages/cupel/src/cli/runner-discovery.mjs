// Find every configured-free test runner with tests in a repository.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function jsTestFiles(root) {
  const found = [];
  const visit = (dir, rel = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['node_modules', 'vendor', 'target', 'venv', '.venv', 'env', 'site-packages'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path, name);
      if (entry.isFile() && /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) found.push({ path: name, text: readFileSync(path, 'utf8') });
    }
  };
  visit(root);
  return found;
}

export function detectedNodeFiles(root) {
  const vitest = isVitestProject(root, {});
  return jsTestFiles(root).filter(({ text }) => /\bnode:test\b/.test(text) ||
    (!vitest && !/\b(?:vitest|@playwright\/test|@jest\/globals|mocha)\b/.test(text))).map((file) => file.path);
}

function hasPytestTests(root) {
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['node_modules', 'vendor', 'testdata', 'venv', 'env', 'site-packages'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory() && visit(path)) return true;
      if (entry.isFile() && /^(test_.*|.*_test)\.py$/.test(entry.name)) return true;
    }
    return false;
  };
  return visit(root);
}

function hasRubyTests(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory() && hasRubyTests(path)) return true;
    if (entry.isFile() && /_test\.rb$/.test(entry.name)) return true;
  }
  return false;
}

export function isVitestProject(root, cfg) {
  if (cfg.runners?.vitest) return true;
  const packageFile = join(root, 'package.json');
  if (existsSync(packageFile)) {
    const pkg = JSON.parse(readFileSync(packageFile, 'utf8'));
    if (pkg.dependencies?.vitest || pkg.devDependencies?.vitest || pkg.optionalDependencies?.vitest) return true;
  }
  return readdirSync(root).some((name) => {
    if (/^vitest\.config\.[cm]?[jt]s$/.test(name)) return true;
    return /^vite\.config\.[cm]?[jt]s$/.test(name) && /\btest\s*:/.test(readFileSync(join(root, name), 'utf8'));
  });
}

export function detectRunners(root, cfg) {
  const names = [];
  const vitest = isVitestProject(root, cfg);
  const javascript = jsTestFiles(root);
  if (vitest && javascript.some(({ text }) => !/\bnode:test\b/.test(text) && !/@playwright\/test/.test(text))) names.push('vitest');
  if (javascript.some(({ text }) => /\bnode:test\b/.test(text) || (!vitest && !/\b(?:vitest|@playwright\/test|@jest\/globals|mocha)\b/.test(text)))) names.push('node');
  if (hasPytestTests(root)) names.push('pytest');
  if (existsSync(join(root, 'go.mod')) && hasGoTests(root)) names.push('go');
  if (existsSync(join(root, 'Gemfile')) && existsSync(join(root, 'test')) && hasRubyTests(join(root, 'test'))) names.push('minitest');
  if (existsSync(join(root, 'Cargo.toml')) || existsSync(join(root, 'src-tauri', 'Cargo.toml'))) {
    if (hasRustTests(root)) names.push('cargo');
  }
  return names;
}

export function detectedConfig(root, name) {
  if (name === 'node') {
    const file = detectedNodeFiles(root)[0];
    const extension = file?.match(/\.(test|spec)\.([cm]?[jt]sx?)$/);
    return extension ? { tests: `**/*.${extension[1]}.${extension[2]}` } : {};
  }
  if (name === 'cargo' && !existsSync(join(root, 'Cargo.toml'))) return { project: 'src-tauri' };
  return {};
}

function hasFiles(dir, test, skip = new Set(['node_modules', 'vendor', 'target', 'venv', '.venv', '.git', '.scratch'])) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory() && hasFiles(path, test, skip)) return true;
    if (entry.isFile() && test(entry.name, path)) return true;
  }
  return false;
}

const hasGoTests = (root) => hasFiles(root, (name) => name.endsWith('_test.go'));
const hasRustTests = (root) => hasFiles(root, (name, path) => name.endsWith('.rs') && /#\[(?:[\w:]+::)?test\]/.test(readFileSync(path, 'utf8')));

