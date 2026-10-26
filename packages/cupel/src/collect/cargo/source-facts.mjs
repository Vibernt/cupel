import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cmp } from '../../engine/order.mjs';

const excluded = new Set(['target', 'vendor', 'node_modules']);
const privatePart = /^(?:credentials(?:[._-].*)?|secrets?(?:[._-].*)?|private(?:[._-].*)?|id_rsa|id_ed25519)$/i;
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function inventory(root, dir = '', out = []) {
  if (dir.split('/').length > 64) throw new Error('Cargo source inventory depth exceeds 64');
  for (const entry of readdirSync(join(root,dir), { withFileTypes:true }).sort((a,b)=>cmp(a.name,b.name))) {
    if (entry.name.startsWith('.') || excluded.has(entry.name)) continue;
    const file = dir ? `${dir}/${entry.name}` : entry.name;
    if (privatePart.test(entry.name) || entry.name.includes('\\')) throw new Error(`unsafe/private Cargo source path: ${file}`);
    if (entry.isSymbolicLink()) throw new Error(`Cargo source inventory contains symlink: ${file}`);
    if (entry.isDirectory()) inventory(root,file,out);
    else if (entry.name.endsWith('.rs')) out.push(file);
  }
  return out;
}
function metadata(root,file) {
  const path=join(root,file); const stat=lstatSync(path);
  if (!stat.isFile() || stat.nlink!==1 || realpathSync(path)!==path || stat.size>32*1024*1024) throw new Error(`unsafe Cargo source identity: ${file}`);
  return {path,stat};
}
function read(root,file,metrics) {
  const {path,stat}=metadata(root,file);
  if (constants.O_NOFOLLOW===undefined) throw new Error('safe Cargo source open unavailable');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes;
  try { const opened=fstatSync(fd);if (!opened.isFile() || opened.nlink!==1 || opened.dev!==stat.dev || opened.ino!==stat.ino || opened.size>32*1024*1024) throw new Error(`Cargo opened source identity changed: ${file}`);bytes=readFileSync(fd); }
  finally {closeSync(fd);}
  if(metrics)metrics.sourceReads=(metrics.sourceReads??0)+1;
  return {bytes,hash:hash(bytes),dev:stat.dev,ino:stat.ino};
}
// Metadata for every retained filename is validated before the first source read.
export class CargoSourceFacts {
  constructor(root,metrics) {
    this.root=resolve(root);this.metrics=metrics;
    if(realpathSync(this.root)!==this.root)throw new Error('Cargo project root must be canonical');
    this.files=inventory(this.root);for(const file of this.files)metadata(this.root,file);
    this.records=new Map(this.files.map((file)=>[file,read(this.root,file,metrics)]));
    this.bytes=new Map([...this.records].map(([file,row])=>[file,row.bytes]));
  }
  sourceHash(file) { const row=this.records.get(file);if(!row)throw new Error(`Cargo coverage source was not in safe initial inventory: ${file}`);return row.hash; }
  assertFresh() {
    if(inventory(this.root).join('\0')!==this.files.join('\0'))throw new Error('Cargo source inventory changed during collection');
    for(const [file,old]of this.records){const cur=read(this.root,file,this.metrics);if(cur.hash!==old.hash || cur.dev!==old.dev || cur.ino!==old.ino)throw new Error(`Cargo source changed during collection: ${file}`);}
  }
}
