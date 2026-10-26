"""Whole-file source identity for one Python mutation or confirmation request."""
import hashlib
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path


class EnvironmentError(RuntimeError):
    pass


class SourceChangedError(EnvironmentError):
    def __init__(self, source, reason):
        super().__init__(f'mutation source changed: {source}: {reason}')


MAX_SOURCE_FACT_BYTES = 32 * 1024 * 1024


class SourceFactsLimitError(EnvironmentError):
    def __init__(self, source, total):
        super().__init__(f'mutation source facts exceed {MAX_SOURCE_FACT_BYTES} retained bytes at {source} ({total} bytes)')


_HASH = re.compile(r'sha256:[0-9a-f]{64}\Z')
_PRIVATE = re.compile(r'(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.ssh|\.aws|\.git|\.scratch|id_rsa|id_ed25519|credentials(?:[._-].*)?|secrets(?:[._-].*)?|private-keys(?:[._-].*)?)\Z', re.I)
_DEPENDENCY = {'node_modules', 'vendor', 'site-packages', 'venv', 'env', '.venv'}


def _components(source):
    if not isinstance(source, str) or not source or '\\' in source or '\0' in source or source.startswith('/'):
        raise EnvironmentError('source path is not canonical and relative')
    parts = source.split('/')
    if any(not part or part in ('.', '..') or part.startswith('.') or
           _PRIVATE.fullmatch(part) or part.lower() in _DEPENDENCY for part in parts):
        raise EnvironmentError('source path is private or noncanonical')
    if not source.endswith('.py'):
        raise EnvironmentError('source is not a Python file')
    return parts


@dataclass(frozen=True)
class _PathIdentity:
    logical: str
    real: str
    root_real: str
    device: int
    inode: int


def _inside(root, path):
    relative = Path(path).relative_to(root)
    _components(relative.as_posix())


def _identity(root, source, expected_root_real=None):
    _components(source)
    logical_root = Path(root).absolute()
    real_root = logical_root.resolve(strict=True)
    if expected_root_real is not None and str(real_root) != expected_root_real:
        raise EnvironmentError('project root changed')
    logical = logical_root.joinpath(*source.split('/'))
    real = logical.resolve(strict=True)
    _inside(real_root, real)
    metadata = real.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise EnvironmentError('source is not a single-link regular file')
    return _PathIdentity(str(logical), str(real), str(real_root), metadata.st_dev, metadata.st_ino)


def source_path(root, source):
    """Validate the source path and return its resolved path without reading content."""
    try:
        return Path(_identity(root, source).real)
    except (OSError, ValueError) as error:
        raise EnvironmentError(f'unsafe Python source path {source}: {error}') from error


@dataclass(frozen=True)
class SourceFact:
    source: str
    path: _PathIdentity
    raw_hash: str
    text: str


class SourceFacts:
    """Request-local ledger; each check opens and hashes current source bytes."""

    def __init__(self, root, input_data, require_hash=False):
        self.root = root
        self.root_real = str(Path(root).absolute().resolve(strict=True))
        self.declared = {source: record.get('hash') for source, record in input_data.get('sources', {}).items()}
        self.require_hash = require_hash
        self.facts = {}
        self.retained_bytes = 0
        for source, digest in self.declared.items():
            if digest is not None and (not isinstance(digest, str) or not _HASH.fullmatch(digest)):
                raise SourceChangedError(source, 'declared input hash is opaque or noncanonical')

    def _read(self, source):
        if source not in self.declared:
            raise SourceChangedError(source, 'source is absent from the current input')
        try:
            path = _identity(self.root, source, self.root_real)
            if not hasattr(os, 'O_NOFOLLOW'):
                raise SourceChangedError(source, 'safe source open is unavailable on this host')
            fd = os.open(path.real, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                opened = os.fstat(fd)
                if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1 or
                        opened.st_dev != path.device or opened.st_ino != path.inode):
                    raise SourceChangedError(source, 'source identity changed before its content read')
                with os.fdopen(os.dup(fd), 'rb') as stream:
                    raw = stream.read()
            finally:
                os.close(fd)
            return path, raw, 'sha256:' + hashlib.sha256(raw).hexdigest()
        except SourceChangedError:
            raise
        except (OSError, ValueError, EnvironmentError) as error:
            raise SourceChangedError(source, f'refused or unreadable source: {error}') from error

    def retain(self, source):
        if source in self.facts:
            raise SourceChangedError(source, 'duplicate source fact')
        if self.require_hash and self.declared.get(source) is None:
            raise SourceChangedError(source, 'confirmation requires a canonical declared input hash')
        path, raw, digest = self._read(source)
        declared = self.declared[source]
        if declared is not None and declared != digest:
            raise SourceChangedError(source, 'declared input hash differs from current bytes')
        if self.retained_bytes + len(raw) > MAX_SOURCE_FACT_BYTES:
            raise SourceFactsLimitError(source, self.retained_bytes + len(raw))
        try:
            text = raw.decode('utf-8')
        except UnicodeError as error:
            raise SourceChangedError(source, f'source is not UTF-8: {error}') from error
        fact = SourceFact(source, path, digest, text)
        self.facts[source] = fact
        self.assert_fresh(source)
        self.retained_bytes += len(raw)
        return fact

    def assert_fresh(self, source):
        fact = self.facts.get(source)
        if fact is None:
            raise SourceChangedError(source, 'accepted source fact is missing')
        path, _, digest = self._read(source)
        if path != fact.path or digest != fact.raw_hash:
            raise SourceChangedError(source, 'bytes or path differ from retained fact')
        return fact

    def assert_all_fresh(self):
        for source in self.facts:
            self.assert_fresh(source)
