import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { CargoSourceFacts } from '../src/collect/cargo/source-facts.mjs';
const base=resolve('.scratch/cargo-source-facts');mkdirSync(base,{recursive:true});
function fixture(){const root=mkdtempSync(join(base,'case-'));mkdirSync(join(root,'src'));writeFileSync(join(root,'src/lib.rs'),'pub fn f() -> i32 { 1 }\n');return root;}
test('Cargo sources bind canonical raw hashes and reject later byte/inventory changes',()=>{
 const root=fixture();const facts=new CargoSourceFacts(root);assert.equal(facts.sourceHash('src/lib.rs'),`sha256:${createHash('sha256').update(readFileSync(join(root,'src/lib.rs'))).digest('hex')}`);facts.assertFresh();
 writeFileSync(join(root,'src/lib.rs'),'pub fn f() -> i32 { 2 }\n');assert.throws(()=>facts.assertFresh(),/changed during collection/);assert.throws(()=>facts.sourceHash('src/unlisted.rs'),/safe initial inventory/);
 const other=fixture();const original=new CargoSourceFacts(other);writeFileSync(join(other,'src/new.rs'),'fn f() {}');assert.throws(()=>original.assertFresh(),/inventory changed/);
});
test('Cargo late symlink/private paths refuse before any content reads',()=>{
 for(const kind of ['symlink','private']){const root=fixture();const metrics={};if(kind==='symlink')symlinkSync(join(root,'src/lib.rs'),join(root,'src/z.rs'));else writeFileSync(join(root,'src/secrets.rs'),'not read');assert.throws(()=>new CargoSourceFacts(root,metrics),/symlink|private/);assert.equal(metrics.sourceReads??0,0);}
});
