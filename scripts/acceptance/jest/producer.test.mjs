import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinnedProducer } from './producer.mjs';

test('producer requires explicit subject/tool/pin and refuses a different artifact', () => {
  const subject=mkdtempSync(join(tmpdir(),'cupel-producer-check-'));
  try {
    const bin=join(subject,'producer.mjs');
    const actual='sha256:'+'a'.repeat(64);
    writeFileSync(bin,`console.log(JSON.stringify({producerHash:${JSON.stringify(actual)}}));\n`);
    const args={directory:join(subject,'logs'),node:process.execPath,bin,subject,
      expectedProducerHash:actual,env:{}};
    assert.equal(pinnedProducer(args).producer.producerHash,actual);
    assert.throws(() => pinnedProducer({...args,expectedProducerHash:'sha256:'+'b'.repeat(64)}),/pin mismatch/);
    assert.throws(() => pinnedProducer({...args,subject:undefined}),/subject is required/);
  } finally {rmSync(subject,{recursive:true});}
});
