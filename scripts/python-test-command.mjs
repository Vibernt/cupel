export function pythonTestCommand(platform = process.platform) {
  return platform === 'win32' ? 'python' : 'python3';
}
