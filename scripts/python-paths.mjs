import { posix, win32 } from 'node:path';

/** A virtual environment's Python, joined with the separators of the platform it is for. */
export function venvPython(root, platform = process.platform) {
  return platform === 'win32' ? win32.join(root, 'Scripts', 'python.exe') : posix.join(root, 'bin', 'python');
}
