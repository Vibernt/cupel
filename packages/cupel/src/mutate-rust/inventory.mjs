import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseRust } from './grammar.mjs';
import { refuse } from './errors.mjs';
import { cmp } from '../engine/order.mjs';

export const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const canonical = /^sha256:[0-9a-f]{64}$/;
const privatePart = /^(?:\..*|credentials(?:[._-].*)?|secrets?(?:[._-].*)?|private(?:[._-].*)?|id_rsa|id_ed25519)$/i;
export function safeName(file) {
  if (typeof file !== 'string' || !file.startsWith('src/') || !file.endsWith('.rs') ||
      file.split('/').some((p) => !p || !/^[A-Za-z_0-9.-]+$/.test(p) || privatePart.test(p)))
    refuse('source-path', `unsafe Rust source path: ${String(file)}`);
}
function regular(root, file) {
  let path = root;
  for (const part of file.split('/')) {
    path = join(path, part); const s = lstatSync(path);
    if (s.isSymbolicLink() || realpathSync(path) !== path) refuse('source-path', `Rust source path must be canonical: ${file}`);
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) refuse('source-path', `Rust file must be bounded single-link regular file: ${file}`);
  return { path, stat };
}
function read(root, file, metrics) {
  const { path, stat } = regular(root, file);
  if (constants.O_NOFOLLOW === undefined) refuse('source-path', 'O_NOFOLLOW unavailable');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); let bytes;
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || !opened.isFile() || opened.nlink !== 1 || opened.size > 1024 * 1024) refuse('source-path', `Rust opened identity changed: ${file}`);
    bytes = readFileSync(fd);
  } finally { closeSync(fd); }
  if (metrics) metrics.sourceReads = (metrics.sourceReads ?? 0) + 1;
  return { bytes, dev: stat.dev, ino: stat.ino, hash: hash(bytes) };
}
function discover(root, dir = 'src', out = []) {
  if (dir.split('/').length > 16) refuse('source-bound', 'Rust directory depth exceeds 16');
  const actual = join(root, dir);
  if (realpathSync(actual) !== actual || !lstatSync(actual).isDirectory()) refuse('source-path', `unsafe Rust directory: ${dir}`);
  const entries = readdirSync(actual, { withFileTypes: true });
  if (entries.length > 128) refuse('source-bound', 'Rust directory inventory exceeds 128 entries');
  for (const entry of entries.sort((a,b) => cmp(a.name,b.name))) {
    const file = `${dir}/${entry.name}`;
    if (privatePart.test(entry.name) || !/^[A-Za-z_0-9.-]+$/.test(entry.name)) refuse('source-path', `private or unsupported Rust path: ${file}`);
    if (entry.isDirectory()) discover(root, file, out);
    else { safeName(file); out.push(file); }
    if (out.length > 64) refuse('source-bound', 'Rust profile accepts at most 64 modules');
  }
  return out;
}
function manifest(text) {
  let table = ''; const values = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    if (/^\[(package|lib)\]$/.test(line)) { table = line.slice(1,-1); continue; }
    const match = /^([a-z-]+)\s*=\s*("[A-Za-z0-9_./ -]+"|true|false)$/.exec(line);
    if (!match || !table || values.has(`${table}.${match[1]}`)) refuse('unsupported-rust-manifest', 'only literal package/lib metadata is supported');
    const key = `${table}.${match[1]}`;
    if (!['package.name','package.version','package.edition','package.publish','package.description','package.license','lib.path','lib.doctest'].includes(key)) refuse('unsupported-rust-manifest', `unsupported Cargo field: ${key}`);
    values.set(key, match[2]);
  }
  const name = values.get('package.name')?.slice(1,-1);
  if (!name || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name) || !/^"[0-9]+\.[0-9]+\.[0-9]+"$/.test(values.get('package.version') ?? '') ||
      !['"2021"','"2024"'].includes(values.get('package.edition')) || (values.has('lib.path') && values.get('lib.path') !== '"src/lib.rs"'))
    refuse('unsupported-rust-manifest', 'requires one ordinary versioned 2021/2024 library at src/lib.rs');
  return { name, version: values.get('package.version').slice(1,-1) };
}
function lock(text, pkg) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const expected = [`version = 4`, '[[package]]', `name = "${pkg.name}"`, `version = "${pkg.version}"`];
  if (lines.length !== 4 || ![3,4].some((n) => lines[0] === `version = ${n}`) || lines.slice(1).join('\n') !== expected.slice(1).join('\n'))
    refuse('unsupported-rust-lock', 'Cargo.lock must contain exactly the local package without dependencies');
}
export function environmentPreflight(root) {
  for (const key of Object.keys(process.env)) if ((/^(?:CARGO_|RUST(?:C|DOC|FLAGS|UP)|SCCACHE|CC$|CXX$)/.test(key)) && process.env[key])
    refuse('unsupported-rust-environment', `custom compiler environment ${key} is unsupported`);
  for (let dir = root;; dir = dirname(dir)) {
    for (const name of ['.cargo/config','.cargo/config.toml','rust-toolchain','rust-toolchain.toml']) if (existsSync(join(dir,name))) refuse('unsupported-rust-environment', `Cargo configuration/toolchain file present: ${join(dir,name)}`);
    if (dir !== root && existsSync(join(dir,'Cargo.toml'))) refuse('unsupported-rust-manifest', 'ancestor Cargo manifest/workspace is unsupported');
    if (dir === dirname(dir)) break;
  }
}
export class RustInventory {
  constructor(root, input, metrics) {
    this.root = resolve(root); this.input = input; this.metrics = metrics;
    if (realpathSync(this.root) !== this.root) refuse('source-path', 'Rust root must be canonical');
    environmentPreflight(this.root);
    for (const name of ['build.rs','tests','examples','benches']) if (existsSync(join(root,name))) refuse('unsupported-rust-channel', `${name} is unsupported`);
    for (const file of Object.keys(input.sources ?? {})) { safeName(file); if (!canonical.test(input.sources[file].hash ?? '')) refuse('source-hash', `canonical Rust source hash required: ${file}`); }
    for (const test of input.tests ?? []) safeName(test.file);
    this.files = discover(this.root);
    for (const file of this.files) if (!Object.hasOwn(input.sources,file)) refuse('source-hash', `complete Rust graph requires a canonical input hash for ${file}`);
    const declared = [...this.files, 'Cargo.toml', 'Cargo.lock'];
    // All metadata is checked before any content read, including late entries.
    for (const file of declared) regular(this.root, file);
    for (const file of [...Object.keys(input.sources), ...input.tests.map((t) => t.file)]) if (!this.files.includes(file)) refuse('source-path', `declared Rust file absent from complete graph: ${file}`);
    this.records = new Map(declared.map((file) => [file, read(this.root,file,metrics)]));
    for (const [file, source] of Object.entries(input.sources)) if (this.records.get(file).hash !== source.hash) refuse('source-changed', `Rust source differs from collected raw hash: ${file}`);
    this.package = manifest(this.text('Cargo.toml')); lock(this.text('Cargo.lock'),this.package);
    this.parsed = new Map(this.files.map((file) => [file, parseRust(this.text(file),file)]));
    this.graph = new Map(); this.tests = new Map();
    const visit = (file, prefix = []) => {
      if (this.graph.has(file)) refuse('unsupported-rust-graph', `duplicate Rust graph source: ${file}`);
      const parsed = this.parsed.get(file); if (!parsed) refuse('unsupported-rust-graph', `missing module source: ${file}`);
      this.graph.set(file, []);
      for (const target of parsed.sourceReads) if (!this.files.includes(target)) refuse('unsupported-rust-channel', `native read target is outside the pinned source graph: ${target}`);
      for (const inc of parsed.includes) if (!this.files.includes(`${dirname(file)}/${inc}`)) refuse('unsupported-rust-channel', `include source is outside inventoried original graph: ${inc}`);
      for (const fn of parsed.functions.filter((fn) => fn.test)) {
        const name = [...prefix, fn.name].join('::'); const id = `${file}::${fn.name.split('::').join(' > ')}`;
        if (this.tests.has(name)) refuse('unsupported-rust-graph', `duplicate harness test: ${name}`);
        this.tests.set(name,{ id,file,name,status:fn.ignored?'skipped':'passed' });
      }
      for (const mod of parsed.modules) {
        if (mod.prefix.length) refuse('unsupported-rust-graph', 'external modules inside inline modules unsupported');
        const base = file === 'src/lib.rs' || file.endsWith('/mod.rs') ? dirname(file) : file.slice(0,-3);
        const choices = [`${base}/${mod.name}.rs`,`${base}/${mod.name}/mod.rs`].filter((path) => this.parsed.has(path));
        if (choices.length !== 1) refuse('unsupported-rust-graph', `module ${mod.name} requires exactly one ordinary source`);
        this.graph.get(file).push({ ...mod, child: choices[0] }); visit(choices[0],[...prefix,mod.name]);
      }
    };
    visit('src/lib.rs');
    if (this.graph.size !== this.files.length) refuse('unsupported-rust-graph', 'orphan Rust files outside complete module graph');
    if (!this.tests.size) refuse('unsupported-rust-graph','Rust graph contains no tests');
    for (const test of input.tests) if (![...this.tests.values()].some((t) => t.id === test.id && t.file === test.file)) refuse('isolation-mismatch',`Rust input test not in complete graph: ${test.id}`);
    if (input.tests.length !== this.tests.size) refuse('isolation-mismatch','Rust input test inventory is incomplete');
  }
  bytes(file) { const row = this.records.get(file); if (!row) refuse('source-path',`source absent: ${file}`); return row.bytes; }
  text(file) { const bytes = this.bytes(file); const text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes) || /[^\x00-\x7f]/.test(text)) refuse('unsupported-rust-syntax',`Rust profile requires ASCII source: ${file}`); return text; }
  assertFresh() {
    environmentPreflight(this.root);
    if (discover(this.root).join('\0') !== this.files.join('\0')) refuse('source-changed','Rust graph inventory changed');
    for (const [file, old] of this.records) { const cur = read(this.root,file,this.metrics); if (cur.dev !== old.dev || cur.ino !== old.ino || cur.hash !== old.hash) refuse('source-changed',`Rust source/config identity changed: ${file}`); }
    for (const name of ['build.rs','tests','examples','benches']) if (existsSync(join(this.root,name))) refuse('source-changed',`Rust compiler channel appeared: ${name}`);
    if (this.metrics) this.metrics.sourceChecks = (this.metrics.sourceChecks ?? 0) + 1;
  }
}
