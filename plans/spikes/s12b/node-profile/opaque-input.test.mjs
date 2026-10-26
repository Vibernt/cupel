import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,linkSync,symlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readOnlyInputSnapshot} from './inputs.mjs';
import {profileRequestSnapshot} from './snapshot.mjs';
import targets from './opaque-target.cjs';

const repo=fileURLToPath(new URL('../../../..',import.meta.url));
const scratch=join(repo,'.scratch/s12b/node-opaque-input-tests');mkdirSync(scratch,{recursive:true});
const policy='express-root-npmrc-opaque-v1';
const put=(root,file,source)=>{const p=join(root,file);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,source);};
const fixture=()=>{const root=mkdtempSync(join(scratch,'fixture-'));
  put(root,'tests/value.test.cjs',"const {test}=require('node:test');test('value',()=>{});\n");return root;};

test('exact root .npmrc is metadata-only and its bytes never enter identity',()=>{
  const root=fixture();put(root,'.npmrc','DUMMY_TEST_VALUE_ONE\n');
  assert.throws(()=>readOnlyInputSnapshot(root),/private input path/);
  const reads=[],hashed=[];
  const snapshot=readOnlyInputSnapshot(root,{inputPolicy:policy,
    readFile:path=>{reads.push(path);return readFileSync(path);},
    hash:bytes=>{hashed.push(bytes.toString());return 'sha256:test';}});
  assert.equal(snapshot.opaqueRootNpmrc,'regular');
  assert.equal(Object.hasOwn(snapshot.files,'.npmrc'),false);
  assert.ok(reads.every(path=>!path.endsWith('/.npmrc')));
  assert.ok(hashed.every(bytes=>!bytes.includes('DUMMY_TEST_VALUE_ONE')));
  const before=profileRequestSnapshot({root,files:['tests/value.test.cjs'],version:'26.7.0',inputPolicy:policy});
  put(root,'.npmrc','DUMMY_TEST_VALUE_TWO\n');
  const after=profileRequestSnapshot({root,files:['tests/value.test.cjs'],version:'26.7.0',inputPolicy:policy});
  assert.deepEqual(after.identity,before.identity);
  assert.equal(after.opaqueRootNpmrc,'regular');
});

test('opaque presence and exact policy are bound in config and environment identity',()=>{
  const root=fixture();
  const absent=profileRequestSnapshot({root,files:['tests/value.test.cjs'],version:'26.7.0',inputPolicy:policy});
  assert.equal(absent.opaqueRootNpmrc,'absent');
  put(root,'.npmrc','DUMMY_TEST_VALUE_ONLY\n');
  const regular=profileRequestSnapshot({root,files:['tests/value.test.cjs'],version:'26.7.0',inputPolicy:policy});
  assert.notEqual(absent.identity.configHash,regular.identity.configHash);
  assert.notEqual(absent.identity.environmentPolicyHash,regular.identity.environmentPolicyHash);
  assert.throws(()=>profileRequestSnapshot({root,files:[],version:'26.7.0',inputPolicy:'ignore-private'}),
    /unsupported Node input policy/);
});

test('package alias to opaque input refuses before test or module resolution',()=>{
  const root=fixture();put(root,'.npmrc','DUMMY_TEST_VALUE_ONLY\n');
  put(root,'package.json',JSON.stringify({name:'fixture',type:'module',
    imports:{'#opaque':'./.npmrc'}}));
  assert.throws(()=>profileRequestSnapshot({root,files:['tests/value.test.cjs'],
    version:'26.7.0',inputPolicy:policy}),/private package module mapping/);
});

test('runtime metadata identifies hardlink and symlink aliases without content reads',()=>{
  const root=fixture();put(root,'.npmrc','DUMMY_TEST_VALUE_ONLY\n');
  linkSync(join(root,'.npmrc'),join(root,'alias.txt'));
  symlinkSync('.npmrc',join(root,'symlink.txt'));
  assert.equal(targets.opaqueAccess(root,join(root,'alias.txt'),'readFileSync'),'opaque-inode-alias');
  assert.equal(targets.opaqueAccess(root,join(root,'symlink.txt'),'readFileSync'),'opaque-inode-alias');
  assert.equal(targets.opaqueAccess(root,join(root,'.npmrc'),'existsSync'),'opaque-path');
  assert.equal(targets.opaqueAccess(root,root,'readdirSync'),'opaque-parent-enumeration');
});

for (const [name,make] of [
  ['hardlink',root=>{put(root,'!alias','DUMMY_TEST_VALUE_ONLY\n');linkSync(join(root,'!alias'),join(root,'.npmrc'));}],
  ['symlink',root=>{put(root,'ordinary.txt','DUMMY_TEST_VALUE_ONLY\n');symlinkSync('ordinary.txt',join(root,'.npmrc'));}],
  ['directory',root=>mkdirSync(join(root,'.npmrc'))],
  ['FIFO',root=>execFileSync('mkfifo',[join(root,'.npmrc')])],
  ['nested private',root=>put(root,'nested/.npmrc','DUMMY_TEST_VALUE_ONLY\n')],
  ['other private',root=>put(root,'.env','DUMMY_TEST_VALUE_ONLY\n')],
  ['case variant',root=>put(root,'.NPMRC','DUMMY_TEST_VALUE_ONLY\n')],
]) test(`${name} remains a preflight refusal with zero content reads`,()=>{
  const root=fixture();make(root);const reads=[];
  assert.throws(()=>readOnlyInputSnapshot(root,{inputPolicy:policy,
    readFile:path=>{reads.push(path);return readFileSync(path);}}));
  assert.deepEqual(reads,[]);
});
