/** File-level failures are kept outside the cupel-spec/1 input schema. */
export function skipFile(diagnostics, log, area, file, error) {
  const cause = String(error?.message ?? error).replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ');
  if (diagnostics.some((item) => item.file === file)) return;
  diagnostics.push({ file, cause });
  log(`${area}: skipped ${file}: ${cause}`);
}
