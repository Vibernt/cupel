import { renameSync, writeFileSync } from 'node:fs';

/** Publish a complete process result, so a killed writer cannot leave a truncated JSON file. */
export function writeAtomicJson(file, value) {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, file);
}
