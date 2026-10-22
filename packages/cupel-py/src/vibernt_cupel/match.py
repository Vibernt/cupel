"""SPEC section 5 path tokens, words and globs for Python mutation scope."""
import re
import unicodedata
from functools import lru_cache


DEFAULT_PATH_WORDS = ('auth', 'permission', 'tenan', 'token', 'secret', 'egress', 'billing', 'quota', 'migrat', 'backup', 'delet', 'public-api', 'credential', 'crypto', 'leak', 'unsafe', 'sign-in', 'login', 'security', 'isolat', 'sandbox', 'privacy', 'integrity', 'redact', 'inject', 'travers', 'harden', 'admission', 'budget')


def _letter_digit(char):
    return unicodedata.category(char).startswith('L') or unicodedata.category(char) == 'Nd'


def tokens(text):
    result, current, lower = [], '', False
    for char in text:
        if not _letter_digit(char):
            if current:
                result.append(current.lower())
            current, lower = '', False
            continue
        upper = unicodedata.category(char) == 'Lu'
        if lower and upper:
            result.append(current.lower())
            current = ''
        current += char
        lower = unicodedata.category(char) == 'Ll'
    if current:
        result.append(current.lower())
    return result


def word_matches(word, text_tokens):
    parts = tokens(word)
    return any(text_tokens[i:i + len(parts) - 1] == parts[:-1] and text_tokens[i + len(parts) - 1].startswith(parts[-1])
               for i in range(len(text_tokens) - len(parts) + 1)) if parts else True


@lru_cache(maxsize=1024)
def _glob_regex(glob, loose):
    segments = glob.split('/')
    segments = [s for i, s in enumerate(segments) if not (set(s) == {'*'} and len(s) >= 2 and i and set(segments[i - 1]) == {'*'} and len(segments[i - 1]) >= 2)]
    result = ''
    for i, segment in enumerate(segments):
        star = len(segment) >= 2 and set(segment) == {'*'}
        if star:
            if len(segments) == 1:
                result += '.*'
            elif i == 0:
                result += '(?:[^/]*/)*'
            elif i == len(segments) - 1:
                result += '(?:/[^/]*)*'
            else:
                result += '/(?:[^/]*/)*'
            continue
        if i and not (len(segments[i - 1]) >= 2 and set(segments[i - 1]) == {'*'}):
            result += '/'
        j = 0
        while j < len(segment):
            if segment[j] == '*':
                end = j
                while end < len(segment) and segment[end] == '*':
                    end += 1
                result += '.*' if loose and end - j >= 2 else '[^/]*'
                j = end
            elif segment[j] == '?':
                result += '[^/]'
                j += 1
            else:
                result += re.escape(segment[j])
                j += 1
    return re.compile('^' + result + '$', re.DOTALL)


def glob_matches(glob, path, loose=False):
    return bool(_glob_regex(glob, loose).fullmatch(path))


def critical_source(path, config):
    tiers = config.get('tiers', {})
    words = [*tiers.get('pathWords', DEFAULT_PATH_WORDS), *tiers.get('extraPathWords', [])]
    return any(glob_matches(glob, path, True) for glob in tiers.get('critical', [])) or any(word_matches(word, tokens(path)) for word in words)
