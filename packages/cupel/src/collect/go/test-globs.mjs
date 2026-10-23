import { globMatches } from '../../engine/match.mjs';

// Runner test globs alone accept brace alternatives. Tier and source globs keep the spec semantics.
export function expandTestBraces(pattern) {
  const match = /\{([^{}]*,[^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  return match[1].split(',').flatMap((part) => expandTestBraces(
    `${pattern.slice(0, match.index)}${part}${pattern.slice(match.index + match[0].length)}`));
}

export function matchesGoTestFile(pattern, file) {
  return expandTestBraces(pattern).some((glob) => globMatches(glob, file));
}
