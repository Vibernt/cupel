export class RustMutationError extends Error {
  constructor(code, message) { super(message); this.name = 'RustMutationError'; this.code = code; }
}
export const refuse = (code, message) => { throw new RustMutationError(code, message); };
