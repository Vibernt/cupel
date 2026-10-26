const path=require('node:path');
const {fileURLToPath}=require('node:url');
const {opaqueAccess}=require('./opaque-target.cjs');
const {privatePath}=require('./privacy.cjs');

/** Check explicit module paths before calling the native resolver. */
function opaqueModuleRequest(root,specifier,parent) {
  if (typeof specifier!=='string') return null;
  if (specifier.startsWith('#')) return 'opaque-alias-unresolved';
  let target;
  try {
    if (specifier.startsWith('file:')) target=fileURLToPath(new URL(specifier));
    else if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
      const base=typeof parent==='string' && parent.startsWith('file:') ? fileURLToPath(parent) : parent;
      target=path.resolve(path.dirname(base||root),specifier.split(/[?#]/,1)[0]);
    } else if (specifier==='.npmrc') target=path.join(root,'.npmrc');
  } catch {return 'opaque-module-unresolved';}
  if (!target) return null;
  if (privatePath(target))
    return 'private-module-path';
  return opaqueAccess(root,target,'module-resolve');
}
module.exports={opaqueModuleRequest};
