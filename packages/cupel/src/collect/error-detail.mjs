import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function collectorError(cause, detail, directory, file = 'collector-error.txt') {
  const path = join(directory, file);
  writeFileSync(path, String(detail));
  const first = String(cause).split(/\r?\n/)[0].slice(0, 400);
  return `${first} (full detail: ${path})`;
}
