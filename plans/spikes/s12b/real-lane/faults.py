"""Prepare two independent source faults in pinned public scratch worktrees."""

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path


FAULTS = {
    "case-accessible": {
        "path": "src/plugins/rehype-accessible-tables.mjs",
        "before": "return node.type === 'element' ? node.tagName : node.name;",
        "after": "return node.type === 'element' ? node.tagName : 'not-a-table';",
    },
    "case-code-tabs": {
        "path": "src/plugins/remark-code-tabs.mjs",
        "before": "const TRIGGER_LANGS = new Set(['cjs', 'mjs']);",
        "after": "const TRIGGER_LANGS = new Set([]);",
    },
}
PACKAGES = ("unist-util-visit", "unist-util-is", "unist-util-visit-parents", "@types/unist")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def replace_once(text, before, after):
    if text.count(before) != 1:
        raise ValueError("source anchor is not unique")
    return text.replace(before, after)


def prepare(base, parent, evidence_dir):
    base, parent, evidence_dir = Path(base), Path(parent), Path(evidence_dir)
    setup = json.loads((evidence_dir / "setup.json").read_text())
    rows = {}
    for name, fault in FAULTS.items():
        root = parent / name
        rev = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
        if rev != setup["sourceCommit"]:
            raise ValueError(f"wrong source revision: {name}")
        if (root / "node_modules").exists():
            raise ValueError(f"package tree already exists: {name}")
        for package in PACKAGES:
            source = base / "node_modules" / package
            target = root / "node_modules" / package
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source, target, symlinks=False)
            actual = {str(path.relative_to(target)): sha(path.read_bytes())
                      for path in target.rglob("*") if path.is_file()}
            if actual != setup["packages"][package]["files"]:
                raise ValueError(f"copied package hash mismatch: {package}")
        source = root / fault["path"]
        old = source.read_bytes()
        source.write_text(replace_once(old.decode(), fault["before"], fault["after"]))
        changed = subprocess.check_output(["git", "diff", "--name-only"], cwd=root, text=True).splitlines()
        if changed != [fault["path"]]:
            raise ValueError(f"unexpected source diff: {name}: {changed}")
        rows[name] = {"sourceCommit": rev, "changedPath": fault["path"],
                      "beforeSha256": sha(old), "afterSha256": sha(source.read_bytes()),
                      "changedFiles": changed}
    (evidence_dir / "faults.json").write_text(json.dumps(rows, indent=2, sort_keys=True) + "\n")
    return rows


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: faults.py BASE_WORKTREE CASE_PARENT PRIVATE_EVIDENCE_DIR")
    print(json.dumps(prepare(*sys.argv[1:]), sort_keys=True))
