import { isAbsolute } from 'node:path';
import { refuse } from './errors.mjs';

const PRIVATE_PART = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.ssh|\.aws|\.git|\.scratch|id_rsa|id_ed25519|credentials(?:[._-].*)?|secrets(?:[._-].*)?|private-keys(?:[._-].*)?)$/i;

export function safeGoName(name, testFile) {
  if (typeof name !== 'string' || !name.endsWith(testFile ? '_test.go' : '.go') ||
      (!testFile && name.endsWith('_test.go')) || isAbsolute(name) ||
      name.includes('\\') || name.includes('\0'))
    refuse('source-path', `unsafe Go source path: ${String(name)}`);
  const parts = name.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.') ||
      PRIVATE_PART.test(part) || ['vendor', 'testdata', 'node_modules'].includes(part)))
    refuse('source-path', `unsafe Go source path: ${name}`);
}

export function safeListedGoName(name) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || name.includes('\\') || name.includes('\0') ||
      name.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.') ||
        PRIVATE_PART.test(part) || ['vendor', 'testdata', 'node_modules'].includes(part)))
    refuse('source-path', `unsafe listed Go file: ${String(name)}`);
}
