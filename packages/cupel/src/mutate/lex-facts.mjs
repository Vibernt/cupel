// One immutable token/bracket view for operators over the same exact text.
import { tokenize, matchBrackets } from '../lang/js/lexer.mjs';

export function lexFacts(text, scannedTokens = null, metrics) {
  const tokens = scannedTokens ?? tokenize(text);
  if (metrics && !scannedTokens) metrics.lexScans = (metrics.lexScans ?? 0) + 1;
  const pairs = matchBrackets(tokens);
  if (metrics) metrics.bracketScans = (metrics.bracketScans ?? 0) + 1;
  return Object.freeze({ tokens, pairs });
}
