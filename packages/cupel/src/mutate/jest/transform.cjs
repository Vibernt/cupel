// Jest loads this wrapper in its own process. The changed source exists only in CUPEL_JEST_MUTANT.
const { createRequire } = require('node:module');
const { appendFileSync } = require('node:fs');
const { realpathSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

const spec = process.env.CUPEL_JEST_MUTANT ? JSON.parse(process.env.CUPEL_JEST_MUTANT) : null;

function sourceFor(source, filename) {
  if (!spec) return source;
  if (realpathSync(filename) !== spec.path) return source;
  if (typeof spec.text !== 'string') throw new Error('Jest mutant has no source text');
  appendFileSync(spec.seen, 'loaded\n');
  return spec.text;
}

module.exports.createTransformer = async function createTransformer(options = {}) {
  let delegate;
  if (options.cupelOriginal) {
    const requireProject = createRequire(options.cupelOriginal);
    let original;
    try { original = requireProject(options.cupelOriginal); }
    catch (error) {
      if (error.code !== 'ERR_REQUIRE_ESM') throw error;
      original = await import(pathToFileURL(options.cupelOriginal).href);
    }
    original = original.default ?? original;
    delegate = original.createTransformer ? await original.createTransformer(options.cupelOptions ?? {}) : original;
  } else delegate = { process: source => ({ code:source }) };
  if (!delegate.process && !delegate.processAsync) throw new Error('project Jest transformer has no process method');
  return {
    canInstrument: delegate.canInstrument ?? false,
    process(source, filename, jestOptions) {
      if (!delegate.process) throw new Error('project Jest transformer is async-only');
      return delegate.process(sourceFor(source, filename), filename, jestOptions);
    },
    async processAsync(source, filename, jestOptions) {
      const text = sourceFor(source, filename);
      return delegate.processAsync ? delegate.processAsync(text, filename, jestOptions) : delegate.process(text, filename, jestOptions);
    },
  };
};
