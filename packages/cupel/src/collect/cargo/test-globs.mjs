import { globMatches } from '../../engine/match.mjs';

function expand(pattern) {
  const match = /\{([^{}]*,[^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  return match[1].split(',').flatMap((part) => expand(`${pattern.slice(0, match.index)}${part}${pattern.slice(match.index + match[0].length)}`));
}

export function matchesTestFile(pattern, file) {
  return expand(pattern).some((part) => globMatches(part, file));
}
