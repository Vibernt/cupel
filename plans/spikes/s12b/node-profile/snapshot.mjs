import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readOnlyInputSnapshot} from './inputs.mjs';
import {loadLockedDependencies} from './dependencies.mjs';
import policies from './input-policy.cjs';
import {assertNoPrivatePackageMappings} from './opaque-package.mjs';
const {normalizeInputPolicy}=policies;

const here=fileURLToPath(new URL('.',import.meta.url));
const digest=data=>`sha256:${createHash('sha256').update(data).digest('hex')}`;
const runtimeFiles=['bootstrap.cjs','policy.cjs','modules.cjs','filesystem.cjs','descriptors.cjs',
  'provenance.cjs','privacy.cjs','input-policy.cjs','nondeterminism.cjs','reporter.mjs','inputs.mjs',
  'dependencies.mjs','opaque-target.cjs','opaque-module.cjs','opaque-package.mjs',
  'opaque-guard-trace.cjs','opaque-guard-fs.cjs','opaque-guard-modules.cjs','opaque-guard.cjs',
  'opaque-full.mjs',
  'snapshot.mjs','launch.mjs'];
const runtimeHash=()=>digest(JSON.stringify(runtimeFiles.map(file=>[file,digest(readFileSync(join(here,file)))])));
export const fixedEnv=Object.freeze({CI:'1',NO_COLOR:'1',TZ:'UTC',LANG:'C'});

export function runtimeVersion(nodePath) {
  const output=nodePath===process.execPath ? process.version : (()=>{
    const result=spawnSync(nodePath,['--version'],{encoding:'utf8',timeout:30000});
    if (result.error || result.status!==0)
      throw new Error(`Node version probe failed: ${result.error?.message??result.stderr}`);
    return result.stdout.trim();
  })();
  if (!/^v\d+\.\d+\.\d+$/.test(output)) throw new Error(`malformed Node runtime version: ${output}`);
  const version=output.slice(1);
  if (!['22.23.3','26.7.0'].includes(version)) throw new Error(`unvalidated Node runtime: ${version}`);
  return version;
}

function identity({files,version,manifest,dependencyLock,inputPolicy,opaqueRootNpmrc}) {
  const packages=Object.fromEntries(Object.entries(manifest).filter(([file])=>file.endsWith('package.json')));
  const profileRuntimeHash=runtimeHash();
  return {
    configHash:digest(JSON.stringify({profile:'node-readonly-files-v1',inputPolicy,opaqueRootNpmrc,
      files:[...files].sort(),packages,
      dependencyLockHash:dependencyLock.lockHash,lockedPackages:dependencyLock.packages})),
    environmentPolicyHash:digest(JSON.stringify({profile:'node-readonly-files-v1',inputPolicy,
      opaqueRootNpmrc,version,env:fixedEnv,
      runtimeHash:profileRuntimeHash,reads:['fixture-root','profile-runtime','per-file-private-tmp'],
      writes:['per-file-private-tmp'],child:false,worker:false,addons:false,wasi:false,
      network:false,nativeTypeStripping:true})),
    inputManifestHash:digest(JSON.stringify(manifest)),
    dependencyLockHash:dependencyLock.lockHash,
    profileRuntimeHash,
  };
}

/** One synchronous privacy preflight and lock read for this capture request. */
export function profileRequestSnapshot({root,files,version,inputPolicy='strict-v1'}) {
  root=resolve(root);
  inputPolicy=normalizeInputPolicy(inputPolicy);
  const {files:manifest,opaqueRootNpmrc}=readOnlyInputSnapshot(root,{nodeModules:'skip',inputPolicy});
  const dependencyLock=loadLockedDependencies(root);
  if (inputPolicy===policies.EXPRESS) assertNoPrivatePackageMappings(root,manifest,dependencyLock);
  return {manifest,opaqueRootNpmrc,inputPolicy,dependencyLock,
    identity:identity({files,version,manifest,dependencyLock,inputPolicy,opaqueRootNpmrc})};
}

export function nodeProfileIdentity({root,files,version,inputPolicy='strict-v1'}) {
  return profileRequestSnapshot({root,files,version,inputPolicy}).identity;
}
