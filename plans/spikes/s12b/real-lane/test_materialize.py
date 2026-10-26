"""Offline safety checks for the one-off tarball materializer."""

import io
import json
import tarfile
import unittest

from materialize import locked_package, validate_archive
from faults import replace_once


def archive(member_name="package/package.json", kind="file"):
    data = json.dumps({"name": "x", "version": "1"}).encode()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as tar:
        item = tarfile.TarInfo(member_name)
        if kind == "symlink":
            item.type = tarfile.SYMTYPE
            item.linkname = "../../outside"
            tar.addfile(item)
        else:
            item.size = len(data)
            tar.addfile(item, io.BytesIO(data))
    return output.getvalue()


class MaterializeTest(unittest.TestCase):
    def test_valid_package_file(self):
        files = validate_archive(archive())
        self.assertEqual(json.loads(files["package.json"])["version"], "1")
        self.assertIn("package.json", validate_archive(archive("unist/package.json"), "unist"))

    def test_traversal_rejected(self):
        with self.assertRaisesRegex(ValueError, "unsafe|outside"):
            validate_archive(archive("package/../../outside"))

    def test_symlink_rejected(self):
        with self.assertRaisesRegex(ValueError, "link"):
            validate_archive(archive(kind="symlink"))

    def test_registry_and_integrity_required(self):
        good = {"packages": {"node_modules/x": {"resolved": "https://registry.npmjs.org/x/-/x-1.tgz",
                                                "version": "1", "integrity": "sha512-" + "AA=="}}}
        self.assertEqual(locked_package(good, "x")[0]["version"], "1")
        good["packages"]["node_modules/x"]["resolved"] = "https://example.test/x.tgz"
        with self.assertRaisesRegex(ValueError, "registry"):
            locked_package(good, "x")

    def test_fault_anchor_must_be_unique(self):
        self.assertEqual(replace_once("one two", "one", "new"), "new two")
        for text in ("no anchor", "one and one"):
            with self.assertRaisesRegex(ValueError, "unique"):
                replace_once(text, "one", "new")


if __name__ == "__main__":
    unittest.main()
