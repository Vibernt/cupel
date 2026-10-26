"""One-off public, lock-pinned test setup for the Express S12b scratch checkout.

Downloads four exact public npm tarballs. It never invokes npm scripts or
changes package.json, the lockfile, or source/test files.
"""

import base64
import hashlib
import hmac
import io
import json
import os
import subprocess
import sys
import tarfile
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath


COMMIT = "4ca3fa8701629a4eb27c76a69aa6d6e294290b40"
PACKAGES = ("unist-util-visit", "unist-util-is", "unist-util-visit-parents", "@types/unist")
MAX_TARBALL = 10 * 1024 * 1024
MAX_UNPACKED = 20 * 1024 * 1024


class SameHostRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlparse(newurl).hostname != "registry.npmjs.org":
            raise ValueError("tarball redirected outside public npm registry")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def locked_package(lock, name):
    entry = lock["packages"]["node_modules/" + name]
    url = entry["resolved"]
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "registry.npmjs.org":
        raise ValueError(f"non-public registry URL for {name}")
    algorithm, digest = entry["integrity"].split("-", 1)
    if algorithm != "sha512":
        raise ValueError(f"unsupported integrity for {name}")
    return entry, url, base64.b64decode(digest, validate=True)


def download(url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), SameHostRedirect())
    request = urllib.request.Request(url, headers={"User-Agent": "cupel-s12b-public-test-setup"})
    with opener.open(request, timeout=20) as response:
        data = response.read(MAX_TARBALL + 1)
    if len(data) > MAX_TARBALL:
        raise ValueError("tarball exceeds size limit")
    return data


def validate_archive(data, root_name="package"):
    files = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            if path.is_absolute() or not path.parts or path.parts[0] != root_name:
                raise ValueError("tar member outside package root")
            if any(part in ("", ".", "..") for part in path.parts):
                raise ValueError("tar member has unsafe path")
            if member.isdir():
                continue
            if not member.isfile() or len(path.parts) < 2:
                raise ValueError("tar member is link or unsupported type")
            relative = PurePosixPath(*path.parts[1:]).as_posix()
            if relative in files:
                raise ValueError("duplicate tar member")
            total += member.size
            if total > MAX_UNPACKED:
                raise ValueError("archive exceeds unpacked size limit")
            files[relative] = archive.extractfile(member).read()
    if "package.json" not in files:
        raise ValueError("tarball missing package metadata")
    return files


def prepare(root, evidence_dir):
    root = Path(root).resolve()
    evidence_dir = Path(evidence_dir).resolve()
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    if sha != COMMIT:
        raise ValueError(f"wrong public source revision: {sha}")
    if (root / "node_modules").exists():
        raise ValueError("node_modules already exists; refusing to overwrite test setup")
    lock = json.loads((root / "package-lock.json").read_text())
    if lock.get("lockfileVersion") != 3:
        raise ValueError("unexpected lockfile format")
    prepared = {}
    for name in PACKAGES:
        entry, url, expected = locked_package(lock, name)
        tarball = download(url)
        if not hmac.compare_digest(hashlib.sha512(tarball).digest(), expected):
            raise ValueError(f"integrity mismatch: {name}")
        files = validate_archive(tarball, name.rsplit("/", 1)[-1] if name.startswith("@") else "package")
        metadata = json.loads(files["package.json"])
        if metadata.get("name") != name or metadata.get("version") != entry["version"]:
            raise ValueError(f"package metadata mismatch: {name}")
        prepared[name] = (entry, tarball, files)
    evidence_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"sourceCommit": sha,
                "lockSha256": hashlib.sha256((root / "package-lock.json").read_bytes()).hexdigest(),
                "packages": {}}
    for name, (entry, tarball, files) in prepared.items():
        target = root / "node_modules" / name
        for relative, content in files.items():
            path = target / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        manifest["packages"][name] = {
            "version": entry["version"], "integrity": entry["integrity"],
            "tarballSha256": hashlib.sha256(tarball).hexdigest(),
            "files": {path: hashlib.sha256(content).hexdigest() for path, content in sorted(files.items())},
        }
    (evidence_dir / "setup.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: materialize.py EXPRESS_ROOT PRIVATE_EVIDENCE_DIR")
    print(json.dumps({"packages": {name: info["version"] for name, info in
                                  prepare(sys.argv[1], sys.argv[2])["packages"].items()}}, sort_keys=True))
