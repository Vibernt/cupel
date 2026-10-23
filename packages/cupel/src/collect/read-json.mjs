import { readFileSync } from 'node:fs';
import { skipFile } from './skipped.mjs';

/** A malformed worker result is absent evidence, not an empty coverage record. */
export function readWorkerJson(file, diagnostics, log, area) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    skipFile(diagnostics, log, area, file, error);
    return null;
  }
}
