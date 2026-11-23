"""No-assertion and tautology checks (test-quality audit, phase 3)."""
import ast
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from vibernt_cupel.weak import weak_flags
from vibernt_cupel.static import findings

SOURCE = '''
import pytest
from mypkg import add
from .helpers import run_case
from tests.support import check_case


def check_sum(x):
    assert x == 3


def test_real():
    assert add(1, 2) == 3


def test_removed():
    x = add(1, 2)


def test_true():
    assert True


def test_self():
    x = add(1, 2)
    assert x == x


def test_literal():
    assert 3 == 3


def test_generator_pairs():
    g = iter(range(3))
    assert next(g) == next(g)


def test_check_kwarg():
    subprocess.run(['true'], check=True)


def test_none():
    add(1, 2)


def test_helper():
    check_sum(add(1, 2))


def test_imported_helper():
    run_case(add(1, 2))


def test_raises():
    with pytest.raises(ValueError):
        add("a", None)


def test_raise_manual():
    if add(1, 2) != 3:
        raise AssertionError("bad")


class TestX:
    def test_eq(self):
        self.assertEqual(add(1, 2), add(1, 2))

    def test_true_method(self):
        self.assertTrue(True)

    def test_mock(self, m):
        m.assert_called_once()

    def check_roundtrip(self, x):
        assert x == add(x, 0)

    def test_method_helper(self):
        self.check_roundtrip(1)
'''

EXPECTED = {
    'test_real': [], 'test_removed': ['no-assertion'], 'test_true': ['tautology'], 'test_self': [],
    'test_literal': ['tautology'], 'test_generator_pairs': [], 'test_check_kwarg': [], 'test_method_helper': [],
    'test_none': ['no-assertion'], 'test_helper': [], 'test_imported_helper': [], 'test_raises': [],
    'test_raise_manual': [], 'test_eq': [], 'test_true_method': ['tautology'], 'test_mock': [],
}


class WeakTests(unittest.TestCase):
    def test_planted_kinds_are_flagged_and_honest_tests_are_not(self):
        tree = ast.parse(SOURCE)
        got = {n.name: [kind for kind, _ in weak_flags(tree, n)] for n in ast.walk(tree)
               if isinstance(n, ast.FunctionDef) and n.name.startswith('test')}
        self.assertEqual(got, EXPECTED)

    def test_findings_carry_the_new_kinds_once(self):
        tree = ast.parse(SOURCE)
        fn = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == 'test_literal')
        self.assertEqual([kind for kind, _, _ in findings(SOURCE, fn, [])], ['tautology'])


if __name__ == '__main__':
    unittest.main()
