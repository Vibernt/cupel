"""Python mutation conformance and subprocess smoke tests."""
import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from vibernt_cupel.match import tokens, word_matches, glob_matches, critical_source
from vibernt_cupel.mutation_sites import apply, generate
from vibernt_cupel.mutation_run import mutate, confirm, whole_units, source_path, EnvironmentError
from vibernt_cupel.__main__ import collect

ROOT = Path(__file__).resolve().parents[3]
PYTEST = Path('/Users/vid/codecrystal/.venv/bin/python')


class SitesTest(unittest.TestCase):
    def test_body_sites_include_async_and_skip_init_and_abstract(self):
        source = ('from abc import abstractmethod\n'
                  'class C:\n'
                  '    def __init__(self):\n        self.x = 1\n'
                  '    @abstractmethod\n    def required(self):\n        pass\n'
                  '    async def work(self):\n        value = 2\n        return value\n')
        sites = list(generate('logic.py', source, functions_only=True))
        self.assertEqual(len(sites), 2)
        self.assertEqual([s.function_name for s in sites], ['work', 'work'])
        self.assertEqual([s.variant for s in sites], [0, 1])
        for site in sites:
            compile(apply(source, site), 'logic.py', 'exec')

    def test_operators_and_logging_exclusion(self):
        source = ('def f(x, y):\n    if not (x < 3 and True):\n        logging.info(x + 1)\n        logger.debug(x < y)\n        print(x == y)\n        return x * y\n    while x != y or False:\n        call(x)\n        return True\n    return x / y\n')
        sites = list(generate('f.py', source))
        operators = {s.operator for s in sites}
        self.assertEqual(operators, {'cmp-flip', 'boundary', 'bool-literal', 'logical', 'negate-cond', 'remove-not', 'arith', 'return-value', 'remove-call', 'body-replace'})
        self.assertFalse(any(s.line in (3, 4, 5) for s in sites))
        for site in sites:
            compile(apply(source, site), 'f.py', 'exec')
        self.assertIn('pass', apply(source, next(s for s in sites if s.operator == 'remove-call')))

    def test_id_stability_and_utf8_positions(self):
        source = 'def café(x):\n    return x + 1\n'
        first = list(generate('src/café.py', source))
        second = list(generate('src/café.py', source))
        self.assertEqual(first, second)
        self.assertEqual([s.id for s in first], [s.id for s in second])
        self.assertIn('return x - 1', apply(source, next(s for s in first if s.operator == 'arith')))
        self.assertEqual([s.id for s in first], [s.id for s in generate('src/café.py', source)])

    def test_multiline_edits_keep_line_numbers(self):
        source = 'def f():\n    return (\n        1 + 2\n    )\n\ndef g():\n    call(\n        3\n    )\n'
        for site in generate('f.py', source):
            changed = apply(source, site)
            self.assertEqual(changed.count('\n'), source.count('\n'))
            compile(changed, 'f.py', 'exec')

    def test_section_five_examples(self):
        self.assertEqual(tokens('src/authService/signIn.ts'), ['src', 'auth', 'service', 'sign', 'in', 'ts'])
        self.assertEqual(tokens('HTTPServer'), ['httpserver'])
        self.assertEqual(tokens('v2Api'), ['v2api'])
        self.assertEqual(tokens('--a__b--'), ['a', 'b'])
        for word, path, expected in [('migrat', 'db/migrations/run.ts', True), ('sign-in', 'tests/signInFlow.test.ts', True), ('sign-in', 'tests/sign/x/in.ts', False), ('public-api', 'src/public_apis.ts', True), ('public-api', 'src/publicity/api.ts', False), ('auth', 'src/oauth.ts', False), ('-', 'anything', True)]:
            self.assertEqual(word_matches(word, tokens(path)), expected)
        for glob, path, loose, expected in [('src/**/auth.ts', 'src/auth.ts', False, True), ('src/**/auth.ts', 'src/a/b/auth.ts', False, True), ('**/auth.ts', 'auth.ts', False, True), ('src/**', 'src/a/b.ts', False, True), ('src/**', 'srcx/a.ts', False, False), ('**', 'a/b/c', False, True), ('src/*.ts', 'src/a.ts', False, True), ('src/*.ts', 'src/a/b.ts', False, False), ('src/?.ts', 'src/a.ts', False, True), ('src/?.ts', 'src/ab.ts', False, False), ('src/a.ts', 'src/a.ts.bak', False, False), ('src/[ab].ts', 'src/[ab].ts', False, True), ('src/[ab].ts', 'src/a.ts', False, False), ('a/**/**/b', 'a/b', False, True), ('src/**.ts', 'src/x/y.ts', False, False), ('src/**.ts', 'src/x/y.ts', True, True)]:
            self.assertEqual(glob_matches(glob, path, loose), expected, (glob, path, loose))
        self.assertTrue(critical_source('src/a/b.py', {'tiers': {'critical': ['src/**.py'], 'pathWords': []}}))
        self.assertTrue(critical_source('src/signIn.py', {}))
        self.assertFalse(critical_source('src/oauth.py', {}))

    def test_whole_units_smallest_first(self):
        text = 'x = True\ny = False\nz = True\n'
        sites = list(generate('x.py', text))
        own = {'big': {'x.py': {1, 2, 3}}, 'small': {'x.py': {2}}}
        self.assertEqual([s.line for s in whole_units(sites, own, 1)], [2])

    def test_source_paths_stay_inside_scope(self):
        for path in ('../secret.py', '/tmp/secret.py', '.env/secret.py'):
            with self.assertRaises(EnvironmentError):
                source_path(ROOT, path)


@unittest.skipUnless(PYTEST.exists(), 'read-only Python with pytest unavailable')
class RunnerTest(unittest.TestCase):
    def setUp(self):
        import subprocess
        if subprocess.run([str(PYTEST), '-c', 'import pytest'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            self.skipTest('pytest unavailable in read-only CodeCrystal interpreter')
        self.python_patch = patch('vibernt_cupel.mutation_run.sys.executable', str(PYTEST))
        self.python_patch.start()
        self.addCleanup(self.python_patch.stop)
        scratch = ROOT / '.scratch'
        scratch.mkdir(exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix='pymut-test-', dir=scratch))
        (self.root / 'tests').mkdir()
        (self.root / 'pyproject.toml').write_text('[tool.pytest.ini_options]\ntestpaths = ["tests"]\n')
        self.source = self.root / 'logic.py'
        self.test = self.root / 'tests/test_logic.py'

    def tearDown(self):
        if hasattr(self, 'root'):
            shutil.rmtree(self.root)

    def input(self, source, test, covered='1-4'):
        self.source.write_text(source)
        self.test.write_text(test)
        uid = 'tests/test_logic.py::test_value'
        return {'sources': {'logic.py': {'coverable': covered}}, 'tests': [{'id': uid, 'file': 'tests/test_logic.py', 'name': 'test_value', 'status': 'passed', 'durationsMs': [1]}], 'coverage': {'granularity': 'test', 'byTest': {uid: {'logic.py': covered}}, 'setup': {'tests/test_logic.py': {}}}}

    def test_function_scope_pseudo_and_checked(self):
        source = ('def ignored(x):\n    answer = x + 1\n    return answer\n\n'
                  'def checked(x):\n    answer = x + 2\n    return answer\n')
        tests = ('from logic import ignored, checked\n'
                 'def test_calls_only():\n    ignored(3)\n\n'
                 'def test_checks_value():\n    assert checked(3) == 5\n')
        self.source.write_text(source)
        self.test.write_text(tests)
        before = {str(path.relative_to(self.root)): hashlib.sha256(path.read_bytes()).hexdigest()
                  for path in (self.source, self.test)}
        input_data = collect(self.root, 1, [], [])
        config = {'mutation': {'maxMutants': 10, 'maxSeconds': 60}}
        first = mutate(self.root, input_data, {'functions': True}, config, jobs=1, timeout_floor_ms=500)
        second = mutate(self.root, input_data, {'functions': True}, config, jobs=1, timeout_floor_ms=500)
        self.assertEqual(first, second)
        self.assertEqual(len(first['mutants']), 3)
        self.assertEqual([m['status'] for m in first['mutants']], ['survived', 'survived', 'killed'])
        self.assertFalse(first['sampled'])
        checked_unit = 'tests/test_logic.py::test_checks_value'
        targeted = mutate(self.root, input_data, {'functions': True, 'targeted': [checked_unit]},
                          config, jobs=1, timeout_floor_ms=500)
        self.assertEqual(targeted['targeted'], [checked_unit])
        capped = mutate(self.root, input_data, {'functions': True, 'targeted': [checked_unit]},
                        {'mutation': {'maxMutants': 1, 'seed': 7}}, jobs=1, timeout_floor_ms=500)
        self.assertEqual([m['line'] for m in capped['mutants']], [6])
        self.assertEqual(capped['targeted'], [checked_unit])
        self.assertEqual(before, {str(path.relative_to(self.root)): hashlib.sha256(path.read_bytes()).hexdigest()
                                  for path in (self.source, self.test)})
        sites = list(generate('logic.py', source, functions_only=True))
        by_id = {m['id']: m for m in first['mutants']}
        self.assertEqual([s.function_name for s in sites if s.variant == 0 and by_id[s.id]['status'] == 'survived'], ['ignored'])
        import subprocess
        catalogue = [{'id': s.id, 'source': s.source, 'operator': s.operator, 'function_key': s.function_key,
                      'function_name': s.function_name, 'start_line': s.start_line,
                      'end_line': s.end_line, 'variant': s.variant} for s in sites]
        module = (ROOT / 'packages/cupel/src/analysis/pseudo.mjs').as_uri()
        script = (f"import {{ analyzePseudo }} from {json.dumps(module)}; "
                  "import { readFileSync } from 'node:fs'; "
                  "const p = JSON.parse(readFileSync(0, 'utf8')); "
                  "process.stdout.write(JSON.stringify(analyzePseudo(p.input, p.sites))); ")
        analyzed = subprocess.run(['node', '--input-type=module', '-e', script],
                                  input=json.dumps({'input': {**input_data, 'mutation': first}, 'sites': catalogue}),
                                  text=True, capture_output=True, check=True)
        report = json.loads(analyzed.stdout)
        self.assertEqual([f['name'] for f in report['pseudoTestedFunctions']], ['ignored'])
        self.assertEqual([f['name'] for f in report['testedFunctions']], ['checked'])
        self.assertEqual([u['id'] for u in report['pseudoTests']], ['tests/test_logic.py::test_calls_only'])
        self.assertEqual([u['pseudoShare'] for u in report['units']], [1, 0])

    def test_kill_caps_determinism_and_no_file_written(self):
        data = self.input('def value(x):\n    if x < 2:\n        return True\n    return False\n', 'from logic import value\ndef test_value():\n    assert value(1) is True\n    assert value(3) is False\n')
        digest = hashlib.sha256(self.source.read_bytes()).digest()
        scope = {'critical': True, 'changed': {}, 'targeted': []}
        config = {'tiers': {'critical': ['logic.py']}, 'mutation': {'maxMutants': 3, 'maxSeconds': 20, 'seed': 8}}
        first = mutate(self.root, data, scope, config, jobs=1, timeout_floor_ms=100)
        second = mutate(self.root, data, scope, config, jobs=1, timeout_floor_ms=100)
        self.assertEqual(first, second)
        self.assertEqual(len(first['mutants']), 3)
        self.assertTrue(first['sampled'])
        self.assertTrue(any(m['status'] == 'killed' and m['killedBy'] == ['tests/test_logic.py::test_value'] for m in first['mutants']))
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).digest(), digest)
        self.assertFalse(list(self.root.rglob('*.pyc')))

    def test_crash_is_error(self):
        data = self.input('def value():\n    return True\n', 'import os\nfrom logic import value\ndef test_value():\n    if not value(): os._exit(7)\n    assert value()\n', '1-2')
        result = mutate(self.root, data, {'changed': {'logic.py': '2'}}, {'mutation': {'maxMutants': 3, 'maxSeconds': 20}}, jobs=1, timeout_floor_ms=100)
        self.assertTrue(result['mutants'])
        self.assertTrue(all(m['status'] == 'error' for m in result['mutants']))

    def test_class_nodeid_kill_uses_cupel_id(self):
        data = self.input('def value():\n    return True\n', 'from logic import value\nclass TestValue:\n    def test_value(self):\n        assert value() is True\n', '1-2')
        old_id = data['tests'][0]['id']
        new_id = 'tests/test_logic.py::TestValue > test_value'
        data['tests'][0].update(id=new_id, name='TestValue > test_value')
        data['coverage']['byTest'][new_id] = data['coverage']['byTest'].pop(old_id)
        result = mutate(self.root, data, {'changed': {'logic.py': '2'}}, {'mutation': {'maxMutants': 1, 'maxSeconds': 20}}, jobs=1, timeout_floor_ms=100)
        self.assertEqual(result['mutants'][0]['killedBy'], [new_id])

    def test_timeout_is_rechecked(self):
        data = self.input('def value():\n    return True\n', 'from logic import value\ndef test_value():\n    if not value():\n        while True: pass\n    assert value()\n', '1-2')
        result = mutate(self.root, data, {'changed': {'logic.py': '2'}}, {'mutation': {'maxMutants': 1, 'maxSeconds': 20}}, jobs=1, timeout_floor_ms=100)
        self.assertEqual(result['mutants'][0]['status'], 'timeout')

    def test_deadline_cuts_running_mutant_and_marks_sampled(self):
        data = self.input('def value():\n    return True\n', 'from logic import value\ndef test_value():\n    if not value():\n        while True: pass\n', '1-2')
        result = mutate(self.root, data, {'changed': {'logic.py': '2'}}, {'mutation': {'maxMutants': 1, 'maxSeconds': 1}}, jobs=1, timeout_floor_ms=100)
        self.assertTrue(result['sampled'])
        self.assertEqual(result['mutants'], [])

    def test_targeted_only_after_all_own_line_mutants_run(self):
        data = self.input('def value(x):\n    if x < 2:\n        return True\n    return False\n', 'from logic import value\ndef test_value():\n    assert value(1)\n', '1-4')
        uid = data['tests'][0]['id']
        scope = {'targeted': [uid]}
        small = mutate(self.root, data, scope, {'mutation': {'maxMutants': 1, 'maxSeconds': 20}}, jobs=1, timeout_floor_ms=100)
        self.assertNotIn(uid, small['targeted'])
        full = mutate(self.root, data, scope, {'mutation': {'maxMutants': 10, 'maxSeconds': 20}}, jobs=1, timeout_floor_ms=100)
        self.assertIn(uid, full['targeted'])
        self.assertFalse(full['sampled'])

    def test_confirm_two_extra_runs(self):
        data = self.input('def value():\n    return True\n', 'from logic import value\ndef test_value():\n    assert True\n', '1-2')
        site = next(iter(generate('logic.py', self.source.read_text())))
        mutation = {'mutants': [{'id': site.id, 'source': site.source, 'line': site.line, 'operator': site.operator, 'status': 'survived'}], 'targeted': [], 'seed': 1, 'sampled': False}
        with patch('vibernt_cupel.mutation_run.Session.once', return_value=('survived', [])) as once:
            result = confirm(self.root, data, mutation, [site.id], timeout_floor_ms=100)
        self.assertEqual(once.call_count, 2)
        self.assertEqual(result, mutation)

    def test_confirm_cli_with_ids(self):
        import subprocess
        data = self.input('def value():\n    return True\n', 'from logic import value\ndef test_value():\n    assert True\n', '1-2')
        site = next(iter(generate('logic.py', self.source.read_text())))
        mutation = {'mutants': [{'id': site.id, 'source': site.source, 'line': site.line, 'operator': site.operator, 'status': 'survived'}], 'targeted': [], 'seed': 1, 'sampled': False}
        input_file, mutation_file, output = (self.root / name for name in ('input.json', 'mutation.json', 'confirmed.json'))
        input_file.write_text(json.dumps(data))
        mutation_file.write_text(json.dumps(mutation))
        env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONPATH': str(Path(__file__).resolve().parents[1] / 'src')}
        run = subprocess.run([str(PYTEST), '-m', 'vibernt_cupel', 'confirm', '--root', str(self.root), '--input', str(input_file), '--mutation', str(mutation_file), '--ids', site.id, '--out', str(output)], env=env, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(output.read_text()), mutation)


if __name__ == '__main__':
    unittest.main()
