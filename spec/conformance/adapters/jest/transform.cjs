const ts = require('typescript');
module.exports = {
  process(sourceText, sourcePath) {
    const result = ts.transpileModule(sourceText, {
      fileName: sourcePath,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
        inlineSourceMap: true, inlineSources: true },
    });
    return { code:result.outputText };
  },
};
