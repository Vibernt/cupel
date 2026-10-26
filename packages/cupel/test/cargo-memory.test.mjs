import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportLines, covered } from '../src/collect/cargo/coverage.mjs';
import { exportLinesFromChunks } from '../src/collect/cargo/export-stream.mjs';
import { execute } from '../src/collect/cargo/process.mjs';

test('streamed LLVM export maps files across arbitrary chunks and ignores large non-file data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cupel-cargo-stream-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/lib.rs'), 'fn café() {\n    let x = 1; // comment\n}\n');
    const source = { data: [{ files: [{ filename: 'src/lib.rs', segments: [
      [1, 1, 1, true, true, false], [1, 11, 0, true, true, false],
      [2, 5, 0, true, true, false], [3, 1, 1, true, true, false],
    ] }], functions: [{ names: 'x'.repeat(1024 * 1024) }] }] };
    const json = JSON.stringify(source);
    async function* chunks() { for (let i = 0; i < json.length; i += 7) yield json.slice(i, i + 7); }
    const streamed = await exportLinesFromChunks(chunks(), root);
    assert.deepEqual(covered(streamed), covered(exportLines(source, root)));
    assert.deepEqual([...streamed.get('src/lib.rs').all], [...exportLines(source, root).get('src/lib.rs').all]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('byte columns preserve Unicode positions at the line boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'cupel-cargo-column-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/lib.rs'), '// 😀\nlet café = 1;\nlet next = 2;\n');
    const files = exportLines({ data: [{ files: [{ filename: 'src/lib.rs', segments: [
      [2, 1, 0, true, true, false], [2, 10, 1, true, true, false],
      [3, 1, 0, true, true, false], [4, 1, 0, false, false, false],
    ] }] }] }, root);
    assert.equal(covered(files)['src/lib.rs'], '2');
    assert.deepEqual([...files.get('src/lib.rs').all], [2, 3]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('byte column after a multibyte Rust comment reaches only the covered code', () => {
  const root = mkdtempSync(join(tmpdir(), 'cupel-cargo-utf8-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/lib.rs'), '/*😀*/ x\n');
    const files = exportLines({ data: [{ files: [{ filename: 'src/lib.rs', segments: [
      [1, 10, 1, true, true, false], [1, 11, 0, true, true, false],
    ] }] }] }, root);
    assert.equal(covered(files)['src/lib.rs'], '1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('streamed export rejects truncated JSON', async () => {
  await assert.rejects(exportLinesFromChunks(['{"data":[{"files":[{"filename":"x"}]}'], '/tmp'), /invalid LLVM coverage JSON/);
  await assert.rejects(exportLinesFromChunks(['{"data":[],"bad":true false}'], '/tmp'), /invalid LLVM coverage JSON/);
});

test('process output can be written to a file without stdout capture', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cupel-cargo-output-'));
  try {
    const path = join(root, 'output.json');
    const result = await execute(process.execPath, ['-e', 'process.stdout.write("ok")'], { root, env: process.env, stdoutPath: path });
    assert.equal(result.stdout, '');
    assert.equal(readFileSync(path, 'utf8'), 'ok');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('large LLVM metadata parses under a small Node heap', () => {
  const root = mkdtempSync(join(tmpdir(), 'cupel-cargo-heap-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/lib.rs'), 'fn main() {}\n');
    const file = join(root, 'export.json');
    writeFileSync(file, '{"data":[{"files":[{"filename":"src/lib.rs","segments":[[1,1,1,true,true,false]]}],"functions":["'
      + 'x'.repeat(32 * 1024 * 1024) + '"]}]}');
    const moduleUrl = new URL('../src/collect/cargo/export-stream.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', `
      import { exportLinesFromFile } from ${JSON.stringify(moduleUrl)};
      const files = await exportLinesFromFile(${JSON.stringify(file)}, ${JSON.stringify(root)});
      if (!files.get('src/lib.rs')?.covered.has(1)) process.exitCode = 1;
      console.log(JSON.stringify({ maxRSS: process.resourceUsage().maxRSS, heapUsed: process.memoryUsage().heapUsed }));
    `], { encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
