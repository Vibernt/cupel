/**
 * A failure's cause as one line without machine-specific paths: a system error by its code (`EACCES`), anything
 * else by its message.
 */
export function causeText(error) {
  const code = error?.code;
  const text = typeof code === 'string' && /^E[A-Z0-9]+$/.test(code) ? code : String(error?.message ?? error);
  return text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ');
}

/** File-level failures are kept outside the cupel-spec/1 input schema. */
export function skipFile(diagnostics, log, area, file, error) {
  const cause = String(error?.message ?? error).replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ');
  if (diagnostics.some((item) => item.file === file)) return;
  diagnostics.push({ file, cause });
  log(`${area}: skipped ${file}: ${cause}`);
}
