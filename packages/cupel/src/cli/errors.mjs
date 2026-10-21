// CLI errors carry the exit code they end with (spec E1).

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_ENV = 3;

export class CliError extends Error {
  constructor(exit, message) {
    super(message);
    this.exit = exit;
  }
}

export const usage = (message) => new CliError(EXIT_USAGE, message);
export const environment = (message) => new CliError(EXIT_ENV, message);
