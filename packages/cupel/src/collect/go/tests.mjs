import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { scanGo, shape } from './lex.mjs';

// The Go binary lists top-level tests; source inspection supplies their stable files and tags.
export function definitions(pkg, root) {
  const found = new Map();
  for (const file of [...(pkg.TestGoFiles ?? []), ...(pkg.XTestGoFiles ?? [])]) {
    const source = readFileSync(join(pkg.Dir, file), 'utf8');
    const tokens = scanGo(source).tokens;
    const lines = source.split('\n');
    for (let i = 0; i + 3 < tokens.length; i++) {
      if (tokens[i].value !== 'func' || !/^Test[A-Z0-9_]/.test(tokens[i + 1].value) || tokens[i + 2].value !== '(') continue;
      const name = tokens[i + 1].value;
      if (found.has(name)) throw new Error(`duplicate Go test ${name} in ${pkg.ImportPath}`);
      let open = i + 3;
      while (open < tokens.length && tokens[open].value !== '{') open++;
      if (open === tokens.length) throw new Error(`missing body for ${name}`);
      let depth = 1;
      let end = open + 1;
      for (; end < tokens.length && depth; end++) {
        if (tokens[end].value === '{') depth++;
        if (tokens[end].value === '}') depth--;
      }
      if (depth) throw new Error(`unclosed body for ${name}`);
      const body = tokens.slice(open + 1, end - 1);
      const rawBody = source.slice(tokens[open].end, tokens[end - 1].start);
      const tag = /^\s*\/\/\s*cupel:(critical|minor|standard)\s*$/.exec(lines[tokens[i].line - 2] ?? '')?.[1];
      const path = relative(root, join(pkg.Dir, file)).split(sep).join('/');
      const spawnsInterpreter = body.some((t, n) => t.value === 'exec' && body[n + 1]?.value === '.' && body[n + 2]?.value === 'Command' && body[n + 3]?.value === '(' && /^['"](?:go|[^'"]+\.test)['"]$/.test(body[n + 4]?.raw ?? ''));
      const readText = /(?:os\.ReadFile|ioutil\.ReadFile|ReadFile)\s*\([^)]*\.(?:go|md|txt|rst)['"`]/s.test(rawBody);
      const assertsText = /(?:assert|require|Equal|Contains|HasPrefix|HasSuffix|Fatalf?|Errorf?)\s*\(/.test(rawBody);
      found.set(name, {
        id: `${path}::${name}`, file: path, name, ...(tag ? { tags: [tag] } : {}),
        spawnsInterpreter, shape: shape(body),
        brittleness: readText && assertsText ? [{ test: `${path}::${name}`, kind: /\.(?:md|txt|rst)['"`]/.test(rawBody) ? 'doc-wording' : 'source-text', line: tokens[i].line }] : [],
      });
      i = end - 1;
    }
  }
  return found;
}
