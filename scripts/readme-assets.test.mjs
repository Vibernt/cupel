import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

test('README visuals resolve locally, have descriptive alternatives and valid PNG dimensions', () => {
  const markdown = [...readme.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)]
    .map(([, alt, src]) => ({ alt, src }));
  const html = [...readme.matchAll(/<img\b[^>]*>/g)].map(([tag]) => ({
    src: /\bsrc="([^"]+)"/.exec(tag)?.[1],
    alt: /\balt="([^"]+)"/.exec(tag)?.[1],
  }));
  const visuals = [...markdown, ...html];
  assert.ok(visuals.length >= 2, 'the README needs its logo and explanation');
  for (const { src, alt } of visuals) {
    assert.ok(alt?.trim().length >= 10, `missing useful alternative text: ${src}`);
    assert.ok(src?.startsWith('docs/assets/'), `asset must ship with the repository: ${src}`);
    const path = resolve(root, src);
    assert.ok(!relative(root, path).startsWith('..'), 'asset escapes the repository');
    const bytes = readFileSync(path);
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
    assert.ok(bytes.readUInt32BE(16) >= 256 && bytes.readUInt32BE(20) >= 256,
      `image is too small for README use: ${src}`);
  }
});
