import unittest

from src.math_ops import add, double


class TestMath(unittest.TestCase):
    def test_adds(self):
        """[critical] Add two values."""
        self.assertEqual(add(2, 3), 5)

    def test_doubles(self):
        """Double one value."""
        self.assertEqual(double(4), 8)

    def test_rejects_wrong_result(self):
        """A deliberate failing fixture test."""
        self.assertEqual(add(2, 3), 99)

    @unittest.skip("fixture demonstrates skipped status")
    def test_skipped_example(self):
        """This must remain skipped."""
        self.fail("a skipped test must not execute")
