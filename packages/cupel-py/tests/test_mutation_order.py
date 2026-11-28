"""Pure ordering and scope integration for pytest mutation."""
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from vibernt_cupel.mutation_order import order_units
from vibernt_cupel.mutation_run import mutate
from vibernt_cupel.mutation_sites import generate


def row(test_id, file, unit=None):
    value = {'id': test_id, 'file': file, 'name': test_id, 'status': 'passed', 'durationsMs': [1]}
    if unit:
        value['unit'] = unit
    return value


class MutationOrderTest(unittest.TestCase):
    def test_history_then_module_named_units_then_input_order(self):
        tests = [
            row('broad', 'tests/broad.py'),
            row('own-1', 'one/test_logic.py', 'own'),
            row('rest', 'tests/rest.py'),
            row('own-2', 'one/test_logic.py', 'own'),
            row('history', 'tests/history.py'),
        ]
        expected = ['history', 'own-1', 'own-2', 'broad', 'rest']
        self.assertEqual([t['id'] for t in order_units(tests, 'pkg/logic.py', ['history', 'history', 'missing'])], expected)
        self.assertEqual([t['id'] for t in order_units(tests, 'pkg/logic.py', ['history'])], expected)
        self.assertCountEqual(order_units(tests, 'pkg/logic.py', ['history']), tests)

    def test_suffix_module_name_is_an_own_file_in_any_directory(self):
        tests = [row('broad', 'tests/broad.py'), row('own', 'deep/logic_test.py')]
        self.assertEqual([t['id'] for t in order_units(tests, 'logic.py')], ['own', 'broad'])

    def test_mutation_scope_catchers_reach_selection(self):
        source = 'def value():\n    return True\n'
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'logic.py').write_text(source, newline='\n')
            tests = [row('broad', 'tests/broad.py'), row('own', 'other/test_logic.py'), row('history', 'tests/history.py')]
            coverage = {t['id']: {'logic.py': '2'} for t in tests}
            input_data = {
                'sources': {'logic.py': {'coverable': '1-2', 'hash': 'sha256:' + hashlib.sha256(source.encode()).hexdigest()}},
                'tests': tests,
                'coverage': {'granularity': 'test', 'byTest': coverage, 'setup': {}},
            }
            fault = next(generate('logic.py', source))
            seen = []

            def once(_session, _site, selected):
                seen.append([test['id'] for test in selected])
                return 'survived', []

            with patch('vibernt_cupel.mutation_run.Session.once', autospec=True, side_effect=once):
                mutate(root, input_data, {'changed': {'logic.py': '2'}, 'catchers': {fault.id: ['history']}},
                       {'mutation': {'maxMutants': 1, 'maxSeconds': 10}}, jobs=1)
            self.assertEqual(seen, [['history', 'own', 'broad']])


if __name__ == '__main__':
    unittest.main()
