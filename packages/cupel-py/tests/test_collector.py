"""Standard-library tests; pytest is needed only for the adapter fixture."""
import ast
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from vibernt_cupel.lines import coverable, line_set, source_record
from vibernt_cupel.sources import scan
from vibernt_cupel.static import shape, findings
from vibernt_cupel.__main__ import collect
from vibernt_cupel.plugin import _name_parts

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / 'spec/conformance/adapters/pytest'
PYTHON = Path('/Users/vid/codecrystal/.venv/bin/python')


def pytest_ready():
    if not PYTHON.exists():
        return False
    env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}
    return subprocess.run([str(PYTHON), '-c', 'import pytest'], env=env, capture_output=True).returncode == 0


def matches(expected, actual, where=''):
    if expected == '$absent':
        return actual is _ABSENT
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(matches(v, actual.get(k, _ABSENT), where + '/' + k) for k, v in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and len(expected) == len(actual) and all(matches(e, a, where) for e, a in zip(expected, actual))
    return expected == actual


_ABSENT = object()


class StaticTests(unittest.TestCase):
    def test_line_rule_excludes_comments_docstrings_and_whitespace(self):
        text = '# comment\n"""module doc"""\nVALUE = 2  # inline\n\ndef f():\n    """doc"""\n    return "two words"\n'
        self.assertEqual(line_set(coverable(text)), '3,5,7')

    def test_source_scope_and_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for rel in ('src/a.py', 'tests/no.py', 'test/no.py', '.venv/no.py', 'src/test_x.py', 'src/x_test.py', 'src/conftest.py'):
                path = root / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('X = 1\n')
            self.assertEqual(list(scan(root)), ['src/a.py'])
            self.assertEqual(scan(root, {'exclude': ['src/**']}), {})
            self.assertEqual(list(scan(root, {'include': ['src/**/*.py']})), ['src/a.py'])
            self.assertTrue(source_record(root / 'src/a.py')['hash'].startswith('sha256:'))

    def test_four_token_fnv_shape(self):
        source = 'def t():\n    return 1\n'
        self.assertEqual(shape(source, ast.parse(source).body[0]), [80632890, 556693214, 1502826019, 4241812480])

    def test_shape_masks_literals_and_patterns(self):
        a = 'def test_pin():\n    assert "class=x" == "class=x"\n'
        b = 'def test_pin():\n    assert "class=y" == "class=y"\n'
        fn = ast.parse(a).body[0]
        self.assertEqual(shape(a, fn), shape(b, ast.parse(b).body[0]))
        self.assertIn(('css-class', 2, False), findings(a, fn, []))
        self.assertIn(('doc-wording', 2, True), findings(a, fn, [{'kind': 'doc-wording', 'pattern': 'class=x', 'language': 'python', 'deliberate': True}]))
        self.assertEqual(findings(a, fn, [{'kind': 'doc-wording', 'pattern': 'class=x', 'language': 'js'}]), [('css-class', 2, False)])

    def test_param_id_keeps_internal_colons(self):
        self.assertEqual(_name_parts('tests/a.py::TestGroup::test_one[a::b]'), ['TestGroup', 'test_one[a::b]'])

    def test_collection_rejects_python_before_312(self):
        with patch('vibernt_cupel.__main__.sys.version_info', (3, 11)):
            with self.assertRaisesRegex(RuntimeError, 'Python 3.12'):
                collect(FIXTURE, 1, [], [])

    def test_strict_brittleness_detects_source_text_pin(self):
        source = ('from pathlib import Path\n'
                  'ROOT = Path(__file__).parent\n'
                  'def test_pin():\n'
                  '    text = (ROOT / "src/x.py").read_text()\n'
                  '    assert "literal" in text\n')
        flags = findings(source, ast.parse(source).body[-1], [])
        self.assertIn(('source-text', 4, False), flags)

    def test_import_does_not_import_pytest(self):
        script = 'import vibernt_cupel, vibernt_cupel.plugin; import sys; assert "pytest" not in sys.modules'
        env = {**os.environ, 'PYTHONPATH': str(ROOT / 'packages/cupel-py/src'), 'PYTHONDONTWRITEBYTECODE': '1'}
        result = subprocess.run([sys.executable, '-c', script], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


@unittest.skipUnless(pytest_ready(), 'pytest unavailable in read-only CodeCrystal Python 3.14 environment')
class FixtureTests(unittest.TestCase):
    def run_adapter(self, *args):
        env = {**os.environ, 'PYTHONPATH': str(ROOT / 'packages/cupel-py/src'), 'PYTHONDONTWRITEBYTECODE': '1'}
        result = subprocess.run([str(PYTHON), '-m', 'vibernt_cupel', *args], env=env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_fixture_matches_hand_checked_expected(self):
        actual = self.run_adapter('collect', '--root', str(FIXTURE), '--runs', '1', '--', '-q', '--strict-markers')
        expected = json.loads((FIXTURE / 'expected.json').read_text())
        self.assertTrue(matches(expected, actual), json.dumps(actual, indent=2))
        self.assertEqual(actual['sources']['src/math.py']['hash'], source_record(FIXTURE / 'src/math.py')['hash'])
        self.assertEqual(len(actual['tests']), 5)
        self.assertTrue(all(len(row['durationsMs']) == 1 for row in actual['tests']))
        self.assertEqual(set(actual['shapes']), {r.get('unit', r['id']) for r in actual['tests']})

    def test_module_import_setup_is_per_test_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'src').mkdir()
            (root / 'tests').mkdir()
            (root / 'src/a.py').write_text('A = 1\n')
            (root / 'src/b.py').write_text('B = 2\n')
            (root / 'tests/test_a.py').write_text('from src import a\ndef test_a(): assert a.A == 1\n')
            (root / 'tests/test_b.py').write_text('from src import b\ndef test_b(): assert b.B == 2\n')
            output = self.run_adapter('collect', '--root', str(root), '--runs', '1', '--', '-q')
            setup = output['coverage']['setup']
            self.assertEqual(setup['tests/test_a.py'], {'src/a.py': '1'})
            self.assertEqual(setup['tests/test_b.py'], {'src/b.py': '1'})

    def test_broad_fixture_setup_stays_out_of_test_bucket(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'src').mkdir()
            (root / 'tests').mkdir()
            (root / 'src/value.py').write_text(
                'def session_value():\n    return 1\n'
                'def class_value():\n    return 2\n'
                'def function_value():\n    return 3\n')
            (root / 'tests/test_case.py').write_text(
                'import pytest\nfrom src.value import session_value, class_value, function_value\n'
                '@pytest.fixture(scope="session")\ndef session_fixture(): return session_value()\n'
                '@pytest.fixture(scope="class")\ndef class_fixture(): return class_value()\n'
                '@pytest.fixture\ndef function_fixture(): return function_value()\n'
                'class TestGroup:\n'
                '    def test_values(self, session_fixture, class_fixture, function_fixture):\n'
                '        assert (session_fixture, class_fixture, function_fixture) == (1, 2, 3)\n')
            output = self.run_adapter('collect', '--root', str(root), '--runs', '1', '--', '-q')
            test_id = 'tests/test_case.py::TestGroup > test_values'
            self.assertEqual(output['coverage']['byTest'][test_id], {'src/value.py': '6'})
            self.assertEqual(output['coverage']['setup']['tests/test_case.py'], {'src/value.py': '1-5'})

    def test_statuses_interpreter_and_config_pattern(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'src').mkdir()
            (root / 'tests').mkdir()
            (root / 'src/value.py').write_text('def value():\n    return 1\n')
            (root / 'tests/test_case.py').write_text(
                'import subprocess, sys, pytest\n'
                'from src.value import value\n'
                '@pytest.mark.xfail\n'
                'def test_xfail(): assert value() == 2\n'
                '@pytest.mark.xfail(strict=True)\n'
                'def test_xpass_strict(): assert value() == 1\n'
                '@pytest.mark.skip\n'
                'def test_skip(): assert value() == 1\n'
                'def test_spawn():\n'
                '    subprocess.run([sys.executable, "-c", "pass"], check=True)\n'
                '    assert value() == 1\n')
            (root / 'cupel.json').write_text(json.dumps({'brittleness': {'patterns': [
                {'kind': 'doc-wording', 'language': 'python', 'pattern': 'test_spawn'}]}}))
            output = self.run_adapter('collect', '--root', str(root), '--runs', '1', '--', '-q')
            rows = {r['name']: r for r in output['tests']}
            self.assertEqual(rows['test_xfail']['status'], 'skipped')
            self.assertEqual(rows['test_xpass_strict']['status'], 'failed')
            self.assertEqual(rows['test_skip']['status'], 'skipped')
            self.assertTrue(rows['test_spawn']['spawnsInterpreter'])
            self.assertIn({'test': 'tests/test_case.py::test_spawn', 'kind': 'doc-wording', 'line': 9}, output['brittleness'])

    def test_list_select_and_recheck(self):
        listed = self.run_adapter('list', '--root', str(FIXTURE), '--', '-q')
        self.assertEqual(len(listed['tests']), 5)
        selected = self.run_adapter('select', 'tests/test_math.py::TestGrouped > test_add', '--root', str(FIXTURE), '--runs', '1')
        self.assertEqual([r['id'] for r in selected['tests']], ['tests/test_math.py::TestGrouped > test_add'])
        repeated = self.run_adapter('collect', '--root', str(FIXTURE), '--runs', '2', '--', '-q')
        self.assertTrue(all(len(row['durationsMs']) == 2 for row in repeated['tests']))
        checked = self.run_adapter('collect', '--root', str(FIXTURE), '--runs', '1', '--recheck', 'tests/test_math.py::@18', '--', '-q')
        self.assertEqual(checked['coverage']['rechecked'], ['tests/test_math.py::@18'])
        self.assertEqual(checked['coverage']['byTest']['tests/test_math.py::test_classify[-1-low]'], {'src/math.py': '8-9'})


if __name__ == '__main__':
    unittest.main()
