"""Serialize experimental pytest trace into the frozen S12b sidecar shape."""

import json
import os
import platform

import pytest


CHANNELS = {"import": "imports", "read": "reads", "probe": "probes",
            "absent-probe": "probes", "enumerate": "directories", "write": "writes"}
CAPABILITIES = ["python-audit-open", "python-cached-import-link",
                "python-directory-enumeration", "python-stat-existence-probe",
                "python-pytest-file-owner"]


def channels(paths, ids=(), unsupported=()):
    data = {name: [] for name in CHANNELS.values()}
    for path, kinds in sorted(paths.items()):
        for kind in kinds:
            data[CHANNELS[kind]].append(path)
    for key in data:
        data[key] = sorted(set(data[key]))
    data["capabilities"] = CAPABILITIES
    data["actualTestedIDs"] = sorted(ids)
    data["unsupported"] = sorted(unsupported)
    return data


def build(edges, unsupported, tested_ids, finished, exitstatus):
    errors = []
    try:
        expected = json.loads(os.environ["CUPEL_PY_PILOT_EXPECTED_FILES"])
        if not isinstance(expected, list) or not all(isinstance(x, str) for x in expected):
            raise ValueError("expected files must be a string list")
        expected = sorted(set(expected))
    except (KeyError, ValueError, json.JSONDecodeError) as exc:
        expected = []
        errors.append(f"expected-files: {type(exc).__name__}")
    if exitstatus:
        errors.append(f"pytest-exit-{int(exitstatus)}")
    if not os.environ.get("CUPEL_PY_PILOT_CONFIG_HASH"):
        errors.append("missing-config-hash")
    if not os.environ.get("CUPEL_PY_PILOT_ENV_HASH"):
        errors.append("missing-environment-policy-hash")
    if expected != sorted(finished):
        errors.append("finished-file-inventory-mismatch")
    ids = {}
    for nodeid in tested_ids:
        file = nodeid.split("::", 1)[0]
        ids.setdefault(file, []).append(nodeid)
    files = {path: channels(edges.get(path, {}), ids.get(path, ()), unsupported.get(path, ()))
             for path in expected}
    return {
        "version": "cupel-pr-dependencies/1",
        "runner": {"name": "pytest", "version": pytest.__version__},
        "runtime": {"name": "python", "version": platform.python_version()},
        "execution": {"isolation": "shared-process",
                      "configHash": os.environ.get("CUPEL_PY_PILOT_CONFIG_HASH"),
                      "environmentPolicyHash": os.environ.get("CUPEL_PY_PILOT_ENV_HASH")},
        "files": files,
        "global": channels(edges.get("__global__", {}), (),
                           set(unsupported.get("__global__", ())) | {"shared-process-state-unproven"}),
        "completion": {"expectedFiles": expected, "finishedFiles": sorted(finished), "errors": errors},
    }
