"""Project path observations and explicit unsupported activity for pytest pilot."""

import os
import stat as statmode
import sys


ROOT = os.path.abspath(os.environ["CUPEL_PY_PILOT_ROOT"])
OUT = os.environ["CUPEL_PY_PILOT_OUT"]
edges = {}
unsupported = {"__global__": set()}
finished = set()
tested_ids = set()
owner = "__global__"
active = True


def relative(path):
    if not isinstance(path, (str, bytes, os.PathLike)):
        return None
    try:
        full = os.path.abspath(os.fsdecode(path))
        if os.path.commonpath((ROOT, full)) == ROOT:
            return os.path.relpath(full, ROOT).replace(os.sep, "/")
    except (OSError, ValueError, TypeError):
        pass
    return None


def record(path, kind):
    if not active:
        return
    rel = relative(path)
    if rel is not None:
        edges.setdefault(owner, {}).setdefault(rel, set()).add(kind)
        if source_caller():
            edges.setdefault("__global__", {}).setdefault(rel, set()).add(kind)
        parts = rel.split("/")
        for index in range(1, len(parts) + 1):
            candidate = os.path.join(ROOT, *parts[:index])
            try:
                if statmode.S_ISLNK(_lstat(candidate).st_mode):
                    mark("symlink-path")
                    break
            except OSError:
                break


def mark(reason):
    unsupported.setdefault(owner, set()).add(reason)


def project_caller():
    """Only application-origin external reads make external evidence incomplete."""
    frame = sys._getframe(2)
    seen_project = False
    while frame:
        path = frame.f_code.co_filename
        if path.startswith("<"):
            frame = frame.f_back
            continue
        rel = relative(path)
        if rel and rel.startswith("plans/spikes/s12b/py-pilot/"):
            frame = frame.f_back
            continue
        if "importlib" in path or "_pytest/assertion/rewrite" in path:
            return seen_project
        if rel and rel != ".":
            seen_project = True
        frame = frame.f_back
    return seen_project


def source_caller():
    frame = sys._getframe(2)
    while frame:
        path = frame.f_code.co_filename
        if not path.startswith("<"):
            rel = relative(path)
            if rel and rel.endswith(".py") and (rel.startswith("src/") or rel.endswith("/conftest.py")):
                return True
        frame = frame.f_back
    return False


def direct_project_caller():
    path = sys._getframe(2).f_code.co_filename
    return not path.startswith("<") and relative(path) is not None


def audit(event, args):
    if not active:
        return
    if event == "open" and args:
        path, mode, flags = args[:3]
        if not project_caller():
            return
        if isinstance(path, int):
            mark("untracked-descriptor")
            return
        write = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
            isinstance(flags, int) and bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
        )
        record(path, "write" if write else "read")
        if write and relative(path) is not None:
            mark("project-write")
        if relative(path) is None:
            mark("external-read-or-write")
    elif event in ("os.listdir", "os.scandir"):
        if project_caller():
            record(args[0] if args else ".", "enumerate")
    elif event in ("os.remove", "os.rename", "os.mkdir", "os.rmdir", "os.chmod", "os.chown", "os.link", "os.symlink"):
        for path in args[:2]:
            if relative(path) is not None:
                mark("project-write")
    elif event in ("subprocess.Popen", "os.fork", "os.posix_spawn", "ctypes.dlopen"):
        mark(event)
    elif event == "os.chdir" and project_caller():
        mark(event)


sys.addaudithook(audit)
_stat = os.stat
_lstat = os.lstat
_access = os.access
_os_open, _os_read, _os_fstat, _os_close = os.open, os.read, os.fstat, os.close
known_fds = set()


def stat(path, *args, **kwargs):
    try:
        value = _stat(path, *args, **kwargs)
    except OSError:
        if project_caller():
            record(path, "absent-probe")
        raise
    if project_caller():
        record(path, "probe")
    return value


def lstat(path, *args, **kwargs):
    try:
        value = _lstat(path, *args, **kwargs)
    except OSError:
        if project_caller():
            record(path, "absent-probe")
        raise
    if project_caller():
        record(path, "probe")
    return value


def access(path, *args, **kwargs):
    value = _access(path, *args, **kwargs)
    if project_caller():
        record(path, "probe" if value else "absent-probe")
    return value


os.stat, os.lstat, os.access = stat, lstat, access


def os_open(path, flags, *args, **kwargs):
    fd = _os_open(path, flags, *args, **kwargs)
    if project_caller() and relative(path) is not None:
        known_fds.add(fd)
    return fd


def os_read(fd, count):
    if project_caller() and fd not in known_fds:
        mark("untracked-descriptor")
    return _os_read(fd, count)


def os_fstat(fd, *args, **kwargs):
    if project_caller() and fd not in known_fds:
        mark("untracked-descriptor")
    return _os_fstat(fd, *args, **kwargs)


def os_close(fd):
    known_fds.discard(fd)
    return _os_close(fd)


os.open, os.read, os.fstat, os.close = os_open, os_read, os_fstat, os_close
