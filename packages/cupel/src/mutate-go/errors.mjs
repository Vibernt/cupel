export class GoMutationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GoMutationError';
    this.code = code;
  }
}

export const refuse = (code, message) => { throw new GoMutationError(code, message); };
