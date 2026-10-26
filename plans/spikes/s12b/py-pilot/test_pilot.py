"""Actual local pytest replay assertions for the bounded Python pilot."""

import json
import unittest

from replay import CASES, SCRATCH, main


class PilotTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        main()
        cls.rows = {json.loads(line)["case"]: json.loads(line)
                    for line in (SCRATCH / "results.jsonl").read_text().splitlines()}

    def test_all_cases_have_actual_baseline_and_expected_outcome(self):
        self.assertEqual(set(self.rows), set(CASES))
        self.assertTrue(all(row["baselineExit"] == 0 and row["ok"] for row in self.rows.values()))

    def test_source_text_and_cached_import_faults_are_caught(self):
        text = self.rows["source-text-pin-plus-exec"]
        self.assertEqual(text["selected"], ["tests/test_pin.py", "tests/test_runtime.py"])
        self.assertNotEqual(text["fullExit"], 0)
        self.assertNotEqual(text["selectedExit"], 0)
        cached = self.rows["cached-constant-import"]
        self.assertEqual(cached["selected"], ["tests/test_a.py", "tests/test_b.py"])
        import_data = self.rows["cached-import-time-data"]
        self.assertEqual(import_data["selected"], ["tests/test_a.py", "tests/test_b.py"])
        trace = json.loads((SCRATCH / "cached-import-time-data/trace.json").read_text())
        self.assertIn("src/data.txt", trace["global"]["reads"])

    def test_shared_process_has_actual_false_green_and_named_parity_failure(self):
        row = self.rows["shared-memory-cross-file"]
        self.assertNotEqual(row["fullExit"], 0)
        self.assertEqual(row["selectedExit"], 0)
        self.assertFalse(row["namedBaseParity"])
        self.assertEqual(row["namedBaseExits"]["tests/test_a.py"], 0)
        self.assertNotEqual(row["namedBaseExits"]["tests/test_b.py"], 0)

    def test_sidecar_identity_completion_and_refusals(self):
        for name, row in self.rows.items():
            with self.subTest(name=name):
                sidecar = json.loads((SCRATCH / name / "trace.json").read_text())
                self.assertEqual(sidecar["version"], "cupel-pr-dependencies/1")
                self.assertEqual(sidecar["runner"]["name"], "pytest")
                self.assertEqual(sidecar["runtime"]["name"], "python")
                self.assertEqual(sidecar["execution"]["isolation"], "shared-process")
                self.assertTrue(sidecar["execution"]["configHash"])
                self.assertTrue(sidecar["execution"]["environmentPolicyHash"])
                self.assertEqual(sidecar["completion"]["errors"], [])
                self.assertEqual(sidecar["completion"]["expectedFiles"], sidecar["completion"]["finishedFiles"])
                self.assertIn("shared-process-state-unproven", sidecar["global"]["unsupported"])
                self.assertTrue(all(file["actualTestedIDs"] for file in sidecar["files"].values()))


if __name__ == "__main__":
    unittest.main()
