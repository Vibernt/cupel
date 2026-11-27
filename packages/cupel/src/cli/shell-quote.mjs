// One argument quoted for the shell `spawn(..., { shell: true })` uses: /bin/sh on POSIX, cmd.exe on Windows, where
// single quotes are literal characters. cmd.exe still expands %VAR% inside double quotes; paths with % are refused.

export function quote(value, platform = process.platform) {
  const text = String(value);
  if (platform !== 'win32') return `'${text.replaceAll("'", "'\"'\"'")}'`;
  if (text.includes('%') || text.includes('"')) throw new Error(`cannot pass ${JSON.stringify(text)} through cmd.exe safely`);
  return `"${text}"`;
}
