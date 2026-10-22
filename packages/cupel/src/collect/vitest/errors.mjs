export class VitestCollectorError extends Error {
  constructor(message) { super(message); this.name = 'VitestCollectorError'; this.exitCode = 3; }
}
