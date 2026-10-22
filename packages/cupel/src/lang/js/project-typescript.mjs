// Scanner-based classification uses only the TypeScript installed in the inspected project.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { analyseMask } from '../../collect/node/lines.mjs';

export function projectTypeScript(root) {
  const require = createRequire(join(root, 'package.json'));
  try {
    const ts = require('typescript');
    if (typeof ts.createScanner !== 'function' || typeof ts.createSourceFile !== 'function') {
      throw new Error(`typescript resolved from ${root} does not expose createScanner and createSourceFile`);
    }
    return ts;
  }
  catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

const codeChar = (c) => !/\s/u.test(c);

/** Token and line classification share one scanner pass and one parsed syntax tree. */
export function scanJsx(ts, source, text) {
  const jsx = /\.tsx$/.test(source);
  const kind = jsx ? ts.ScriptKind.TSX : /\.jsx$/.test(source) ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true, kind);
  if (tree.parseDiagnostics.length) throw new Error(ts.flattenDiagnosticMessageText(tree.parseDiagnostics[0].messageText, '\n'));
  const excluded = [];
  const typeOnly = [];
  const visit = (node) => {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
        ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.importClause?.isTypeOnly)) {
      typeOnly.push([node.getStart(tree), node.end]);
      return;
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxClosingElement(node) || ts.isJsxSelfClosingElement(node) ||
        ts.isJsxText(node) || ts.isRegularExpressionLiteral(node)) {
      excluded.push([node.getStart(tree), node.end]);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, jsx || kind === ts.ScriptKind.JSX ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard, text);
  const mask = new Uint8Array(text.length);
  const tokens = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const locate = (pos) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: pos - lineStarts[lo] };
  };
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const start = scanner.getTokenPos(), end = scanner.getTextPos();
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia ||
        kind === ts.SyntaxKind.WhitespaceTrivia || kind === ts.SyntaxKind.NewLineTrivia || kind === ts.SyntaxKind.ShebangTrivia) continue;
    const value = text.slice(start, end);
    for (let i = start; i < end; i++) if (codeChar(text[i])) mask[i] = 1;
    if (excluded.some(([a, b]) => start < b && end > a) || typeOnly.some(([a, b]) => start < b && end > a)) continue;
    const type = kind === ts.SyntaxKind.Identifier || (kind >= ts.SyntaxKind.FirstKeyword && kind <= ts.SyntaxKind.LastKeyword) ? 'name' :
      kind === ts.SyntaxKind.NumericLiteral || kind === ts.SyntaxKind.BigIntLiteral ? 'num' :
      kind === ts.SyntaxKind.StringLiteral ? 'string' :
      [ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail].includes(kind) ? 'template' :
      kind === ts.SyntaxKind.RegularExpressionLiteral ? 'regex' : 'punct';
    tokens.push({ type, value, start, end, ...locate(start) });
  }
  for (const [a, b] of typeOnly) for (let i = a; i < b; i++) mask[i] = 0;
  return { tokens, analysis: analyseMask(text, mask, 'typescript') };
}

export function parseTypeScript(ts, source, text) {
  const kind = /\.tsx$/.test(source) ? ts.ScriptKind.TSX : /\.jsx$/.test(source) ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, false, kind);
  return tree.parseDiagnostics.length ? ts.flattenDiagnosticMessageText(tree.parseDiagnostics[0].messageText, '\n') : null;
}
