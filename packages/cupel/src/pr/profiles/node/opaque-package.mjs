import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import privacy from './privacy.cjs';

const privateTarget=value=>{
  if (typeof value==='string') return privacy.privatePath(value);
  if (Array.isArray(value)) return value.some(privateTarget);
  if (value && typeof value==='object') return Object.values(value).some(privateTarget);
  return false;
};

/** Reject package mappings that could make a safe specifier resolve to private input. */
export function assertNoPrivatePackageMappings(root,manifest,dependencyLock) {
  const packages=new Set(Object.keys(manifest).filter(file=>file.endsWith('package.json')));
  for (const key of Object.keys(dependencyLock.packages)) packages.add(`${key}/package.json`);
  for (const file of packages) {
    const json=JSON.parse(readFileSync(join(root,file),'utf8'));
    for (const key of ['main','exports','imports'])
      if (privateTarget(json[key]))
        throw new Error(`node profile refuses private package module mapping: ${file}:${key}`);
  }
}
