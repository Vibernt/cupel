"""Cached import linkage and concurrency flags for the pytest pilot."""

import builtins
import importlib
import sys
import threading

import trace_paths as paths
from trace_paths import direct_project_caller, mark, record, relative


_import = builtins.__import__
_import_module = importlib.import_module
_thread_start = threading.Thread.start


def module_file(module):
    path = getattr(module, "__file__", None)
    if path:
        record(path, "import")
        if str(path).endswith((".so", ".pyd", ".dylib")) and relative(path) is not None:
            mark("project-native-module")


def imported(name, globals=None, locals=None, fromlist=(), level=0):
    try:
        result = _import(name, globals, locals, fromlist, level)
    except ImportError:
        if direct_project_caller():
            mark("failed-import-unproven")
        raise
    if paths.active:
        try:
            package = (globals or {}).get("__package__")
            resolved = importlib.util.resolve_name("." * level + name, package) if level else name
            module_file(sys.modules.get(resolved, result))
            for child in fromlist or ():
                if isinstance(child, str):
                    module_file(sys.modules.get(f"{resolved}.{child}"))
        except (ImportError, ValueError, TypeError):
            mark("unresolved-import-link")
    return result


def import_module(name, package=None):
    try:
        result = _import_module(name, package)
    except ImportError:
        if direct_project_caller():
            mark("failed-import-unproven")
        raise
    module_file(result)
    return result


def thread_start(self, *args, **kwargs):
    mark("thread-start")
    return _thread_start(self, *args, **kwargs)


builtins.__import__ = imported
importlib.import_module = import_module
threading.Thread.start = thread_start
