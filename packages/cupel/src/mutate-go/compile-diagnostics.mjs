import { basename } from 'node:path';

// Go compiler diagnostics name the logical file under -overlay. Only a
// diagnostic on the mutated source can justify excluding a candidate.
export function isInvalidGoSource(result, source, backingFile) {
  if (result.status === 0 || result.signal || result.timedOut) return false;
  const lines = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines[0]?.startsWith('# ')) return false;
  let diagnosed = false;
  for (const line of lines) {
    if (line.startsWith('# ')) continue;
    if (line === 'too many errors') continue;
    const match = line.match(/^(.+?\.go):(\d+)(?::\d+)?:\s+(.+)$/);
    if (!match) return false;
    const path = match[1].replace(/^\.\//, '');
    const backed = backingFile && (path === backingFile || backingFile.endsWith(`/${path}`));
    if (path !== source && path !== basename(source) && !path.endsWith(`/${source}`) && !backed) return false;
    // Toolchain/environment failures may appear as text, but are not
    // ordinary source diagnostics even if a path prefix is present.
    if (/\b(?:no space left|out of memory|signal:|killed|internal compiler error|panic:)\b/i.test(match[3])) return false;
    if (!/^(?:syntax error:|invalid operation:|cannot use |cannot convert |undefined:|undeclared name:|too many arguments|not enough arguments|assignment mismatch:|multiple-value |non-boolean condition|operator |expected |unexpected |invalid character |missing return|cannot assign |invalid argument:|cannot range over |cannot call |not enough return values|too many return values|mismatched types|cannot refer to|no new variables|imported and not used|declared and not used|invalid constant type|cannot infer |not in scope)/.test(match[3])) return false;
    diagnosed = true;
  }
  return diagnosed;
}
