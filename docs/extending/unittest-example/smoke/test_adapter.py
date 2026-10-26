import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADAPTER = ROOT / "adapter.py"
FIXTURE = ROOT / "conformance" / "unittest-basic"


class AdapterSmokeTests(unittest.TestCase):
    def run_adapter(self, *args, cwd=FIXTURE):
        return subprocess.run(
            [sys.executable, str(ADAPTER), *map(str, args)],
            cwd=cwd, text=True, capture_output=True, check=False,
        )

    def test_list_inventory_and_tags_operation(self):
        result = self.run_adapter("--root", FIXTURE, "--list")
        self.assertEqual(result.returncode, 0, result.stderr)
        entries = json.loads(result.stdout)
        ids = [entry["id"] for entry in entries]
        self.assertEqual(ids, sorted(ids))
        self.assertEqual(len(ids), 4)
        self.assertTrue(all(set(entry) == {"id", "file", "name", "tags"} for entry in entries))
        tagged = next(entry for entry in entries if "test_adds" in entry["id"])
        self.assertEqual(tagged["tags"], ["critical"])

        tags_result = self.run_adapter("--root", FIXTURE, "--tags")
        self.assertEqual(tags_result.returncode, 0, tags_result.stderr)
        tags = json.loads(tags_result.stdout)
        self.assertEqual(next(item["tags"] for item in tags if "test_adds" in item["id"]), ["critical"])

    def test_exact_selection_has_no_extra_test(self):
        selected = "tests/test_math.py::TestMath.test_adds [critical]"
        result = self.run_adapter("--root", FIXTURE, "--select", selected)
        self.assertEqual(result.returncode, 0, result.stderr)
        document = json.loads(result.stdout)
        self.assertEqual([item["id"] for item in document["tests"]], [selected])
        self.assertEqual(document["tests"][0]["status"], "passed")

    def test_missing_and_extra_selection_fail(self):
        missing = "tests/missing.py::Test.test_missing"
        result = self.run_adapter("--root", FIXTURE, "--select", missing)
        self.assertEqual(result.returncode, 3)
        self.assertIn("unknown test id", result.stderr)

        valid = "tests/test_math.py::TestMath.test_adds [critical]"
        result = self.run_adapter("--root", FIXTURE, "--select", valid, missing)
        self.assertEqual(result.returncode, 3)
        self.assertIn("unknown test id", result.stderr)

    def test_boundaries_measure_setup_and_each_test_separately(self):
        result = self.run_adapter("--root", FIXTURE, "--boundaries")
        self.assertEqual(result.returncode, 0, result.stderr)
        document = json.loads(result.stdout)
        self.assertEqual([test["status"] for test in document["tests"]],
                         ["passed", "passed", "failed", "skipped"])
        self.assertEqual(document["sources"]["src/math_ops.py"]["coverable"], "1-2,5-6")
        self.assertEqual(document["coverage"]["setup"]["tests/test_math.py"]["src/math_ops.py"], "1,5")
        by_test = document["coverage"]["byTest"]
        self.assertEqual(by_test["tests/test_math.py::TestMath.test_adds [critical]"]["src/math_ops.py"], "2")
        self.assertEqual(by_test["tests/test_math.py::TestMath.test_doubles"]["src/math_ops.py"], "6")
        self.assertEqual(by_test["tests/test_math.py::TestMath.test_rejects_wrong_result"]["src/math_ops.py"], "2")
        self.assertEqual(by_test["tests/test_math.py::TestMath.test_skipped_example"], {})

    def test_import_error_is_environment_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            shutil.copytree(FIXTURE / "tests", root / "tests")
            shutil.copytree(FIXTURE / "src", root / "src")
            (root / "tests" / "test_broken.py").write_text("this is not valid python !!!\n", encoding="utf-8")
            result = self.run_adapter("--root", root)
        self.assertEqual(result.returncode, 3)
        self.assertIn("discovery failed", result.stderr)

    def test_recheck_and_multiple_runs_are_explicitly_unsupported(self):
        result = self.run_adapter("--root", FIXTURE, "--runs", "2")
        self.assertEqual(result.returncode, 3)
        self.assertIn("exactly 1", result.stderr)
        result = self.run_adapter("--root", FIXTURE, "--recheck", "some-unit")
        self.assertEqual(result.returncode, 3)
        self.assertIn("recheck is unsupported", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
