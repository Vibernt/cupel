import { join } from 'node:path';

export function venvPython(root, platform = process.platform) {
  return join(root, platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}
