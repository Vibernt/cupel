import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import privacy from './privacy.cjs';

const hash=data=>`sha256:${createHash('sha256').update(data).digest('hex')}`;
const supportedFile=rel=>/\.(?:[cm]?js|json)$/.test(rel)&&
  !privacy.privatePath(rel);
const inside=(base,path)=>path===base||path.startsWith(base+sep);
const checkedStat=(root,rel)=>{
  let current=root,stat;
  for (const part of rel.split('/')) {
    current=join(current,part);
    try { stat=lstatSync(current); }
    catch (error) { if (error.code==='ENOENT') return null; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`node profile refuses symlinked dependency path: ${rel}`);
  }
  return stat;
};

export function loadLockedDependencies(root) {
  root=resolve(root);
  const path=join(root,'package-lock.json');
  const modules=join(root,'node_modules');
  if (!existsSync(path)) {
    if (existsSync(modules)) throw new Error('node profile refuses installed packages without package-lock.json');
    return {lockHash:null,packages:{}};
  }
  checkedStat(root,'node_modules');
  let lock,lockBytes;
  try { lockBytes=readFileSync(path); lock=JSON.parse(lockBytes.toString('utf8')); }
  catch (error) { throw new Error(`node profile requires readable package-lock.json: ${error.message}`); }
  if (![2,3].includes(lock.lockfileVersion)||!lock.packages||typeof lock.packages!=='object')
    throw new Error('node profile requires npm package-lock v2 or v3 packages');
  const packages={};
  for (const [key,value] of Object.entries(lock.packages)) {
    if (!key) continue;
    if (!key.startsWith('node_modules/') && !key.includes('/node_modules/'))
      throw new Error(`invalid locked package path: ${key}`);
    const path=resolve(root,key);
    if (!inside(root,path)||!value||typeof value.version!=='string')
      throw new Error(`invalid locked package record: ${key}`);
    if (privacy.privatePath(key))
      throw new Error(`node profile refuses private package path: ${key}`);
    // Sparse test fixtures need only the installed closure; an uninstalled lock
    // entry cannot be loaded and becomes a runner failure if a test imports it.
    if (!checkedStat(root,key)) continue;
    const packageFile=join(path,'package.json');
    if (!checkedStat(root,`${key}/package.json`))
      throw new Error(`installed package lacks package.json: ${key}`);
    const installed=JSON.parse(readFileSync(packageFile,'utf8'));
    const expectedName=key.split('node_modules/').at(-1);
    if (installed.version!==value.version || installed.name!==expectedName)
      throw new Error(`installed package metadata mismatches lock: ${key}`);
    packages[key]={version:value.version,name:installed.name};
  }
  return {lockHash:hash(lockBytes),packages};
}

export function observedDependencyEvidence(root,files,lock) {
  root=resolve(root);
  const evidence={};
  const roots=Object.keys(lock.packages).sort((a,b)=>b.length-a.length);
  const observed=new Set(files);
  for (const rel of files) {
    const owner=roots.find(key=>rel===key+'/package.json'||rel.startsWith(key+'/'));
    if (owner) observed.add(owner+'/package.json');
  }
  for (const rel of [...observed].sort()) {
    if (!rel.includes('node_modules/')) continue;
    const packageRoot=roots.find(key=>rel===key+'/package.json'||rel.startsWith(key+'/'));
    if (!packageRoot) throw new Error(`unlocked dependency path: ${rel}`);
    const path=resolve(root,rel);
    if (!inside(root,path)) throw new Error(`dependency escapes fixture: ${rel}`);
    const stat=checkedStat(root,rel);
    if (!stat) continue;
    if (stat.isDirectory()) continue;
    if (!stat.isFile()||!supportedFile(rel)) throw new Error(`unsupported dependency file: ${rel}`);
    evidence[rel]=hash(readFileSync(path));
  }
  return evidence;
}
