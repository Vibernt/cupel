import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const input = JSON.parse(readFileSync(0, 'utf8'));
if (!Array.isArray(input) || typeof vm.SourceTextModule !== 'function')
  throw new Error('Node PR fixed validity worker lacks module parser');
const result = input.map(({ mode, text }) => {
  if (typeof text !== 'string' || !['commonjs', 'module'].includes(mode))
    throw new Error('Node PR fixed validity worker received unsupported source mode');
  try {
    if (mode === 'commonjs') vm.compileFunction(text,
      ['exports', 'require', 'module', '__filename', '__dirname']);
    else new vm.SourceTextModule(text);
    return { valid: true };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { valid: false, error: `${error.name}: ${error.message}` };
  }
});
process.stdout.write(JSON.stringify(result));
