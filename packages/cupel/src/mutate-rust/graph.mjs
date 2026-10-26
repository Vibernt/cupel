import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { applyRustSite } from './sites.mjs';
export function materializeGraph(inventory, scratch, site) {
  const mapping = inventory.files.map((file) => ({ original: file, scratch: join(scratch,dirname(file),`__cupel_${basename(file)}`) }));
  const byFile = new Map(mapping.map((row) => [row.original,row.scratch]));
  for (const {original:file,scratch:path} of mapping) {
    mkdirSync(dirname(path),{recursive:true});
    let text = (site?.source === file ? applyRustSite(inventory.bytes(file),site) : inventory.bytes(file)).toString('utf8');
    for (const mod of [...inventory.graph.get(file)].sort((a,b) => b.start-a.start))
      text = text.slice(0,mod.start) + `#[path=${JSON.stringify(byFile.get(mod.child))}] mod ${mod.name};` + text.slice(mod.end);
    writeFileSync(path,text);
    symlinkSync(join(inventory.root,file),join(dirname(path),basename(file)));
  }
  return { root:byFile.get('src/lib.rs'), mappings:mapping.map((row) => [row.scratch,row.original]) };
}
