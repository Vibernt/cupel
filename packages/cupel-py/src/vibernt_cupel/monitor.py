"""sys.monitoring coverage buckets, based on the S6 spike."""
import os
import sys


class Monitor:
    def __init__(self, root, source_paths):
        if not hasattr(sys, 'monitoring'):
            raise RuntimeError('collection requires Python 3.12+ (sys.monitoring)')
        self.root = os.path.realpath(root)
        self.sources = set(source_paths)
        self.api = sys.monitoring
        self.events = self.api.events
        self.tool = None
        self.armed = {}  # id(code) -> code; identity matters for duplicate loads
        self.buckets = {'setup': set()}
        self.current = 'setup'
        self.cache = {}

    def path(self, filename):
        if filename not in self.cache:
            full = os.path.realpath(filename)
            rel = os.path.relpath(full, self.root).replace(os.sep, '/')
            self.cache[filename] = rel if rel in self.sources else None
        return self.cache[filename]

    def start(self):
        for tool in (self.api.COVERAGE_ID, 3, 4):
            if self.api.get_tool(tool) is None:
                self.api.use_tool_id(tool, 'vibernt-cupel')
                self.tool = tool
                break
        if self.tool is None:
            raise RuntimeError('no free sys.monitoring tool id for vibernt-cupel')
        self.api.register_callback(self.tool, self.events.PY_START, self._start_code)
        self.api.register_callback(self.tool, self.events.LINE, self._line)
        self.api.set_events(self.tool, self.events.PY_START)

    def _start_code(self, code, offset):
        if self.path(code.co_filename) is None:
            return self.api.DISABLE
        if id(code) not in self.armed:
            self.armed[id(code)] = code
            self.api.set_local_events(self.tool, code, self.events.LINE)
        return self.api.DISABLE

    def _line(self, code, line):
        rel = self.path(code.co_filename)
        if rel is not None:
            self.buckets[self.current].add((rel, line))
        return self.api.DISABLE

    def switch(self, bucket):
        self.current = bucket
        self.buckets.setdefault(bucket, set())
        self.api.restart_events()

    def close(self):
        if self.tool is not None:
            self.api.set_events(self.tool, 0)
            self.api.free_tool_id(self.tool)
            self.tool = None
