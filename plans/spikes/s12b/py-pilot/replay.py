"""Actual pytest oracle/selected replay for the experimental trace plugin."""

import json
import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

from cases import BASE, CASES


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
SCRATCH = REPO / ".scratch/s12b/py-pilot"
PYTHON = REPO / ".scratch/package-tools/runtime/bin/python"


def put(root, path, text):
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text)


def run_pytest(root, name, paths=(), trace=False, external=None):
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(SCRATCH),
           "PYTHONDONTWRITEBYTECODE": "1", "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
           "PYTHONPATH": f"{HERE}{os.pathsep}{root}", "CUPEL_PY_PILOT_ROOT": str(root),
           "CUPEL_PY_PILOT_OUT": str(root / "trace.json")}
    if external:
        env["PILOT_EXTERNAL"] = str(external)
    cmd = [str(PYTHON), "-m", "pytest", "-q", "-p", "no:cacheprovider"]
    if trace:
        cmd += ["-p", "trace_plugin"]
    cmd += list(paths or ["tests"])
    expected = sorted(str(p.relative_to(root)) for p in (root / "tests").glob("test_*.py")) if not paths else sorted(paths)
    env["CUPEL_PY_PILOT_EXPECTED_FILES"] = json.dumps(expected)
    config = {"argv": cmd[3:], "pyprojectSha256": hashlib.sha256((root / "pyproject.toml").read_bytes()).hexdigest()}
    env["CUPEL_PY_PILOT_CONFIG_HASH"] = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
    env["CUPEL_PY_PILOT_ENV_HASH"] = hashlib.sha256(json.dumps(env, sort_keys=True).encode()).hexdigest()
    result = subprocess.run(cmd, cwd=root, env=env, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=30, check=False)
    (root / f"{name}.log").write_text(result.stdout)
    return result.returncode


def observed_replay_files(trace, changed):
    """Probe path matching only; shared-process state still blocks shipping."""
    if trace["completion"]["errors"]:
        raise ValueError("incomplete pytest execution")
    reasons = set(trace["global"]["unsupported"]) - {"shared-process-state-unproven"}
    reasons.update(x for file in trace["files"].values() for x in file["unsupported"])
    if reasons:
        raise ValueError("unsupported dependency activity")
    test_files = set(trace["files"])
    selected = []
    for test in sorted(test_files):
        records = [trace["global"], trace["files"][test]]
        if any(changed in record[key] for record in records for key in ("imports", "reads", "probes")) or any(
            changed.startswith(directory.rstrip("/") + "/")
            for record in records for directory in record["directories"]
        ):
            selected.append(test)
    return selected


def replay_case(name, case):
    root = SCRATCH / name
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    for path, data in {**BASE, **case["files"]}.items():
        put(root, path, data)
    external = SCRATCH / "external.txt" if name in ("external-read", "symlink-boundary") else None
    if external:
        external.write_text("green\n")
    if "link" in case:
        (root / case["link"]).symlink_to(external)
    baseline = run_pytest(root, "baseline", trace=True, external=external)
    trace = json.loads((root / "trace.json").read_text())
    reasons = sorted((set(trace["global"]["unsupported"]) - {"shared-process-state-unproven"}) |
                     {reason for file in trace["files"].values() for reason in file["unsupported"]})
    row = {"case": name, "baselineExit": baseline, "pathTraceComplete": not reasons and
           not trace["completion"]["errors"], "selectionSafe": False,
           "reasons": reasons, "completion": trace["completion"]}
    if name == "shared-memory-cross-file":
        row["namedBaseExits"] = {file: run_pytest(root, f"named-base-{Path(file).stem}", paths=[file])
                                 for file in trace["files"]}
    if "incomplete" in case:
        row["expectedReason"] = case["incomplete"]
        row["ok"] = baseline == 0 and case["incomplete"] in reasons
        return row
    change = case["change"]
    row["changed"] = change
    row["changedEdges"] = {test: [key for key in ("imports", "reads", "probes", "directories")
                                   if change in data[key] or (key == "directories" and
                                       str(Path(change).parent).replace(os.sep, "/") in data[key])]
                           for test, data in trace["files"].items()}
    if "create" in case:
        put(root, change, case["create"])
    else:
        before = (root / change).read_text()
        assert case["before"] in before
        (root / change).write_text(before.replace(case["before"], case["after"]))
    row["fullExit"] = run_pytest(root, "full", external=external)
    if name == "shared-memory-cross-file":
        row["namedHeadExits"] = {file: run_pytest(root, f"named-head-{Path(file).stem}", paths=[file])
                                 for file in trace["files"]}
        row["namedBaseParity"] = all(code == 0 for code in row["namedBaseExits"].values())
    try:
        row["selected"] = observed_replay_files(trace, change)
        row["selectedExit"] = run_pytest(root, "selected", paths=row["selected"], external=external)
        expected_selected = 0 if case.get("expected_miss") else 1
        row["expectedMiss"] = bool(case.get("expected_miss"))
        row["ok"] = (baseline == 0 and row["fullExit"] != 0
                     and int(row["selectedExit"] != 0) == expected_selected
                     and set(case["must_select"]).issubset(row["selected"])
                     and (name != "shared-memory-cross-file" or not row["namedBaseParity"]))
    except ValueError as exc:
        row["refusal"] = str(exc)
        row["ok"] = False
    return row


def main():
    if not PYTHON.is_file():
        raise SystemExit(f"required isolated pytest interpreter missing: {PYTHON}")
    SCRATCH.mkdir(parents=True, exist_ok=True)
    rows = [replay_case(name, case) for name, case in CASES.items()]
    (SCRATCH / "results.jsonl").write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows))
    for row in rows:
        print(f"{row['case']}: {'PASS' if row['ok'] else 'FAIL'}; traceComplete={row['pathTraceComplete']}; "
              f"selected={row.get('selected')}; reasons={row['reasons']}")
    if not all(row["ok"] for row in rows):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
