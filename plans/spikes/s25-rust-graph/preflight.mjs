import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export class UnsupportedRustGraph extends Error {
  constructor(channel) {
    super(`S25 graph proof refuses ${channel}`);
    this.code = 'unsupported-rust-graph';
    this.channel = channel;
  }
}

const refuse = (channel) => { throw new UnsupportedRustGraph(channel); };

// This is a conservative scanner for the controlled proof fixture only.
export function preflightGraph(root) {
  const manifest = readFileSync(join(root, 'Cargo.toml'), 'utf8');
  if (existsSync(join(root, 'build.rs')) || /^\s*build\s*=/m.test(manifest)) refuse('build-script');
  if (/^\s*proc-macro\s*=\s*true\b/m.test(manifest)) refuse('proc-macro');
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const type = lstatSync(path);
      if (type.isSymbolicLink() || !type.isFile() && !type.isDirectory()) refuse('generated-source');
      if (type.isDirectory()) { walk(path); continue; }
      if (!name.endsWith('.rs')) continue;
      const source = readFileSync(path, 'utf8');
      if (/\binclude!\s*\(/.test(source)) refuse('include-macro');
      if (/\#\s*\[\s*path\s*=/.test(source)) refuse('path-attribute');
      if (/\#\s*\[\s*cfg(?:_attr)?\s*\(/.test(source)) refuse('cfg');
      if (/\bOUT_DIR\b|\bgenerated(?:_source)?\.rs\b/.test(source)) refuse('generated-source');
    }
  };
  walk(join(root, 'src'));
}
