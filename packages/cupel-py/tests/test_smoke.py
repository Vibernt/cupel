import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import vibernt_cupel  # noqa: E402


class SmokeTest(unittest.TestCase):
    def test_spec_version(self):
        self.assertEqual(vibernt_cupel.SPEC_VERSION, "cupel-spec/1")


if __name__ == "__main__":
    unittest.main()
