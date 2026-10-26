import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportSession, transformSelect } from './instrument.mjs';
import { assertSource, PRODUCT_MUTATE_HASH, sha256, sourceDigest } from './pin.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = join(repo, '.scratch/s19');
mkdirSync(scratch, { recursive: true });
const product = join(repo, 'packages/cupel');
assertSource(join(product, 'src/mutate'), PRODUCT_MUTATE_HASH);
const productClosure = { sourceHash: sourceDigest(join(product, 'src')),
  schemaHash: sourceDigest(join(product, 'schemas')),
  parserHash: sha256(readFileSync(join(product, 'src/engine/lines.mjs'))) };
const root = mkdtempSync(join(scratch, 'runtime-'));
const copies = {};
for (const mode of ['control', 'instrumented', 'outer']) {
  const packageRoot = join(root, mode, 'packages/cupel');
  cpSync(join(product, 'src'), join(packageRoot, 'src'), { recursive: true });
  cpSync(join(product, 'schemas'), join(packageRoot, 'schemas'), { recursive: true });
  const index = join(packageRoot, 'src/mutate/index.mjs');
  const current = readFileSync(index, 'utf8');
  const transformed = mode === 'control' ? exportSession(current) :
    exportSession(transformSelect(current, mode === 'outer' ? 'outer' : 'full'));
  writeFileSync(index, transformed);
  copies[mode] = { module: index,
    mutationSourceHash: sourceDigest(join(packageRoot, 'src/mutate')),
    sourceHash: sourceDigest(join(packageRoot, 'src')),
    schemaHash: sourceDigest(join(packageRoot, 'schemas')),
    parserHash: sha256(readFileSync(join(packageRoot, 'src/engine/lines.mjs'))) };
}
assertSource(join(product, 'src/mutate'), PRODUCT_MUTATE_HASH);
assertSource(join(product, 'src'), productClosure.sourceHash);
assertSource(join(product, 'schemas'), productClosure.schemaHash);
const manifest = { version: 'cupel-s19-runtime/1', root, productMutationSourceHash: PRODUCT_MUTATE_HASH,
  productClosure,
  sourceSelectHash: '6073bca97712239b7b09277d2e5feea89d826b9c94f5bc5fc464933c682f15b7',
  copies, note: 'Scratch copies only; control appends a Session export for input-only replay; instrumented/outer additionally transform only Session.select.' };
writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(`${join(root, 'manifest.json')}\n`);
