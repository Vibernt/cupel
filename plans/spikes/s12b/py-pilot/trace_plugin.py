"""Experimental pytest plugin. Load with ``-p trace_plugin`` before collection."""

import json
import os
from pathlib import Path

import pytest
import trace_paths as trace
import trace_imports  # Installs cached-import and thread observers.
from sidecar import build


OUT = os.environ["CUPEL_PY_PILOT_OUT"]
finished = set()
tested_ids = set()


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_pycollect_makemodule(module_path, parent):
    previous = trace.owner
    rel = trace.relative(module_path)
    if rel:
        trace.owner = rel
    try:
        yield
    finally:
        trace.owner = previous


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_make_collect_report(collector):
    previous = trace.owner
    if isinstance(collector, pytest.Module):
        trace.owner = trace.relative(collector.path) or "__global__"
    try:
        yield
    finally:
        trace.owner = previous


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_protocol(item, nextitem):
    previous = trace.owner
    trace.owner = trace.relative(item.path) or "__global__"
    try:
        yield
    finally:
        trace.owner = previous


def pytest_runtest_logreport(report):
    if report.when == "call" and not report.skipped:
        tested_ids.add(report.nodeid)
    if report.when == "teardown":
        finished.add(report.nodeid.split("::", 1)[0])


def pytest_sessionfinish(session, exitstatus):
    trace.active = False
    payload = build(trace.edges, trace.unsupported, tested_ids, finished, exitstatus)
    Path(OUT).write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
