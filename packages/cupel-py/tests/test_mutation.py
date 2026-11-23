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
from vibernt_cupel.mutation_source import SourceChangedError, SourceFacts, SourceFactsLimitError
from vibernt_cupel.__main__ import collect

ROOT = Path(__file__).resolve().parents[3]
PYTEST = Path(sys.executable)


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
        for path in ('../secret.py', '/tmp/secret.py', '.env/secret.py', 'credentials.py',
                     'vendor/file.py', 'a//b.py', 'a/./b.py', 'a\\b.py'):
            with self.assertRaises(EnvironmentError):
                source_path(ROOT, path)


@unittest.skipUnless(PYTEST.exists(), 'Python interpreter unavailable')
class RunnerTest(unittest.TestCase):
    def setUp(self):
        import subprocess
        if subprocess.run([str(PYTEST), '-c', 'import pytest'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            self.skipTest('pytest unavailable in the test interpreter')
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
        return {'sources': {'logic.py': {'coverable': covered, 'hash': 'sha256:' + hashlib.sha256(self.source.read_bytes()).hexdigest()}}, 'tests': [{'id': uid, 'file': 'tests/test_logic.py', 'name': 'test_value', 'status': 'passed', 'durationsMs': [1]}], 'coverage': {'granularity': 'test', 'byTest': {uid: {'logic.py': covered}}, 'setup': {'tests/test_logic.py': {}}}}

    def test_source_pin_rejects_same_size_same_mtime_edit_with_same_site_id(self):
        original = 'HEADER = 1\ndef value():\n    return True\n'
        data = self.input(original, 'from logic import value\ndef test_value():\n    assert True\n', '1-3')
        site = next(s for s in generate('logic.py', original) if s.operator == 'return-value')
        before = self.source.stat()
        changed = original.replace('HEADER = 1', 'HEADER = 2')
        self.assertEqual(len(changed), len(original))
        self.assertIn(site.id, {s.id for s in generate('logic.py', changed)})
        self.source.write_text(changed)
        os.utime(self.source, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(self.source.stat().st_size, before.st_size)
        self.assertEqual(self.source.stat().st_mtime_ns, before.st_mtime_ns)
        mutation = {'mutants': [{'id': site.id, 'source': site.source, 'line': site.line,
                                 'operator': site.operator, 'status': 'survived'}], 'targeted': []}
        with self.assertRaisesRegex(SourceChangedError, 'declared input hash differs'):
            confirm(self.root, data, mutation, [site.id])

    def test_source_paths_and_opaque_hash_refuse_before_read(self):
        data = self.input('def value():\n    return True\n', 'def test_value():\n    assert True\n', '1-2')
        (self.root / '.private.py').write_text('SECRET = 1\n')
        (self.root / 'alias.py').symlink_to(self.root / '.private.py')
        (self.root / 'linked.py').hardlink_to(self.source)
        with patch('vibernt_cupel.mutation_source.os.open', side_effect=AssertionError('source bytes read')):
            for path in ('.private.py', 'credentials.py', 'alias.py', 'linked.py'):
                with self.subTest(path=path), self.assertRaises(SourceChangedError):
                    SourceFacts(self.root, {'sources': {path: {'coverable': '1'}}}).retain(path)
            data['sources']['logic.py']['hash'] = 'opaque-hash'
            with self.assertRaisesRegex(SourceChangedError, 'opaque or noncanonical'):
                SourceFacts(self.root, data)

    def test_source_facts_are_bounded(self):
        data = self.input('def value():\n    return True\n', 'def test_value():\n    assert True\n', '1-2')
        with patch('vibernt_cupel.mutation_source.MAX_SOURCE_FACT_BYTES', 8):
            with self.assertRaises(SourceFactsLimitError):
                SourceFacts(self.root, data).retain('logic.py')

    def test_confirmation_requires_declared_source_pin(self):
        data = self.input('def value():\n    return True\n', 'def test_value():\n    assert True\n', '1-2')
        del data['sources']['logic.py']['hash']
        site = next(iter(generate('logic.py', self.source.read_text())))
        mutation = {'mutants': [{'id': site.id, 'source': site.source, 'line': site.line,
                                 'operator': site.operator, 'status': 'survived'}], 'targeted': []}
        with self.assertRaisesRegex(SourceChangedError, 'requires a canonical declared input hash'):
            confirm(self.root, data, mutation, [site.id])

    def _writing_test(self, mutant_only):
        condition = "if os.environ.get('CUPEL_MUTANT_SPEC'):\n" if mutant_only else 'if True:\n'
        return ('import os\nfrom pathlib import Path\nfrom logic import value\n'
                'def test_value():\n    source = Path(__file__).resolve().parents[1] / "logic.py"\n'
                '    stamp = source.stat()\n    before = source.read_text()\n'
                f'    {condition}'
                '        source.write_text(before.replace("return True", "return False"))\n'
                '        os.utime(source, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))\n'
                '    assert value() is True\n')

    def test_baseline_source_write_refuses_actual_pytest(self):
        data = self.input('def value():\n    return True\n', self._writing_test(False), '1-2')
        with self.assertRaisesRegex(SourceChangedError, 'bytes or path differ'):
            mutate(self.root, data, {'changed': {'logic.py': '2'}},
                   {'mutation': {'maxMutants': 1, 'maxSeconds': 20}}, jobs=1)

    def test_mutant_source_write_refuses_actual_pytest(self):
        data = self.input('def value():\n    return True\n', self._writing_test(True), '1-2')
        with self.assertRaisesRegex(SourceChangedError, 'bytes or path differ'):
            mutate(self.root, data, {'changed': {'logic.py': '2'}},
                   {'mutation': {'maxMutants': 1, 'maxSeconds': 20}}, jobs=1)

    def test_confirmation_source_write_refuses_actual_pytest(self):
        data = self.input('def value():\n    return True\n', self._writing_test(True), '1-2')
        site = next(s for s in generate('logic.py', self.source.read_text()) if s.operator == 'return-value')
        mutation = {'mutants': [{'id': site.id, 'source': site.source, 'line': site.line,
                                 'operator': site.operator, 'status': 'survived'}], 'targeted': []}
        with self.assertRaisesRegex(SourceChangedError, 'bytes or path differ'):
            confirm(self.root, data, mutation, [site.id])

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

    def rows(self, test, names, units=None):
        data = self.input('def value():\n    return True\n', test, '1-2')
        uid = data['tests'][0]['id']
        data['tests'] = []
        for name in names:
            tid = f'tests/test_logic.py::{name}'
            row = {'id': tid, 'file': 'tests/test_logic.py', 'name': name, 'status': 'passed', 'durationsMs': [1]}
            if units and name in units:
                row['unit'] = units[name]
            data['tests'].append(row)
            data['coverage']['byTest'][tid] = {'logic.py': '1-2'}
        del data['coverage']['byTest'][uid]
        return data

    def killed(self, data, scope):
        result = mutate(self.root, data, {'changed': {'logic.py': '2'}, **scope}, {'mutation': {'maxMutants': 5, 'maxSeconds': 30}}, jobs=1, timeout_floor_ms=100)
        killed = [m for m in result['mutants'] if m['status'] == 'killed']
        self.assertTrue(killed)
        return killed

    def test_early_stop_after_two_units(self):
        names = ['test_a', 'test_b', 'test_c', 'test_d']
        test = 'from logic import value\n' + ''.join(f'def {n}():\n    assert value() is True\n' for n in names)
        for mutant in self.killed(self.rows(test, names), {}):
            self.assertEqual(mutant['killedBy'], ['tests/test_logic.py::test_a', 'tests/test_logic.py::test_b'])

    def test_first_catch_stops_after_one_unit(self):
        names = ['test_a', 'test_b', 'test_c', 'test_d']
        test = 'from logic import value\n' + ''.join(f'def {n}():\n    assert value() is True\n' for n in names)
        for mutant in self.killed(self.rows(test, names), {'firstCatch': True}):
            self.assertEqual(mutant['killedBy'], ['tests/test_logic.py::test_a'])

    def test_no_early_stop_on_rows_of_one_unit(self):
        names = ['test_a[1]', 'test_a[2]', 'test_a[3]', 'test_b', 'test_c']
        test = ('import pytest\nfrom logic import value\n@pytest.mark.parametrize("n", [1, 2, 3])\ndef test_a(n):\n    assert value() is True\n'
                'def test_b():\n    assert value() is True\ndef test_c():\n    assert value() is True\n')
        data = self.rows(test, names, {f'test_a[{n}]': 'tests/test_logic.py::test_a' for n in (1, 2, 3)})
        for mutant in self.killed(data, {}):
            self.assertEqual(mutant['killedBy'], [f'tests/test_logic.py::{n}' for n in names[:4]])

    def test_no_early_stop_when_targeted_unit_covers(self):
        names = ['test_a', 'test_b', 'test_c']
        test = 'from logic import value\n' + ''.join(f'def {n}():\n    assert value() is True\n' for n in names)
        for mutant in self.killed(self.rows(test, names), {'targeted': ['tests/test_logic.py::test_c']}):
            self.assertEqual(mutant['killedBy'], [f'tests/test_logic.py::{n}' for n in names])

    def test_baseline_failure_is_not_credited_for_early_stop(self):
        names = ['test_a', 'test_b', 'test_c']
        test = ('from logic import value\ndef test_a():\n    assert False\n'
                'def test_b():\n    assert value() is True\ndef test_c():\n    assert value() is True\n')
        for mutant in self.killed(self.rows(test, names), {}):
            self.assertEqual(mutant['killedBy'], ['tests/test_logic.py::test_b', 'tests/test_logic.py::test_c'])

    def test_reuse_skips_run_and_keeps_order_and_cap(self):
        data = self.input('def value(x):\n    if x < 2:\n        return True\n    return False\n', 'from logic import value\ndef test_value():\n    assert value(1)\n', '1-4')
        scope = {'changed': {'logic.py': ''}}
        config = {'mutation': {'maxMutants': 2, 'maxSeconds': 20, 'seed': 3}}
        with patch('vibernt_cupel.mutation_run.Session.once', return_value=('survived', [])) as once:
            fresh = mutate(self.root, data, scope, config, jobs=1, timeout_floor_ms=100)
        self.assertEqual(once.call_count, 2)
        self.assertTrue(fresh['sampled'])
        first, second = fresh['mutants']
        row = {**first, 'status': 'killed', 'killedBy': ['tests/test_logic.py::test_value'], 'note': 'earlier run'}
        with patch('vibernt_cupel.mutation_run.Session.once', return_value=('survived', [])) as once:
            again = mutate(self.root, data, {**scope, 'reuse': {first['id']: row}}, config, jobs=1, timeout_floor_ms=100)
        self.assertEqual(once.call_count, 1)
        self.assertEqual(again['mutants'], [row, second])
        self.assertIsNot(again['mutants'][0], row)
        self.assertEqual({k: again[k] for k in ('targeted', 'seed', 'sampled')}, {k: fresh[k] for k in ('targeted', 'seed', 'sampled')})
        with patch('vibernt_cupel.mutation_run.Session.once', return_value=('survived', [])) as once:
            empty = mutate(self.root, data, {**scope, 'reuse': {}}, config, jobs=1, timeout_floor_ms=100)
        self.assertEqual(empty, fresh)

    def test_reuse_skipped_when_a_targeted_unit_covers_the_mutant(self):
        data = self.input('def value(x):\n    if x < 2:\n        return True\n    return False\n', 'from logic import value\ndef test_value():\n    assert value(1)\n', '1-4')
        scope = {'changed': {'logic.py': ''}}
        config = {'mutation': {'maxMutants': 2, 'maxSeconds': 20, 'seed': 3}}
        with patch('vibernt_cupel.mutation_run.Session.once', return_value=('survived', [])):
            fresh = mutate(self.root, data, scope, config, jobs=1, timeout_floor_ms=100)
        reuse = {m['id']: {**m, 'status': 'killed', 'killedBy': ['tests/test_logic.py::test_value']} for m in fresh['mutants']}
        unit = data['tests'][0].get('unit', data['tests'][0]['id'])
        with patch('vibernt_cupel.mutation_run.Session.once', return_value=('survived', [])) as once:
            again = mutate(self.root, data, {**scope, 'targeted': [unit], 'reuse': reuse}, config, jobs=1, timeout_floor_ms=100)
        self.assertEqual(once.call_count, len(fresh['mutants']))
        self.assertTrue(all(m['status'] == 'survived' for m in again['mutants']))

    BRANCH = 'def value(x):\n    if x < 2:\n        return True\n    return False\n'

    def recorded(self, data, scope, config, status='survived', pause=0):
        calls = []
        def once(session, site, selected):
            calls.append(site.id)
            if pause:
                import time
                time.sleep(pause)
            return (status, [])
        with patch('vibernt_cupel.mutation_run.Session.once', autospec=True, side_effect=once):
            result = mutate(self.root, data, scope, config, jobs=1, timeout_floor_ms=100)
        return result, calls

    def test_plan_has_the_run_selection_and_order(self):
        data = self.input(self.BRANCH, 'from logic import value\ndef test_value():\n    assert value(1)\n', '1-4')
        uid = data['tests'][0]['id']
        scope = {'changed': {'logic.py': ''}}
        config = {'mutation': {'maxMutants': 3, 'maxSeconds': 20, 'seed': 3}}
        fresh, calls = self.recorded(data, scope, config)
        plan, none = self.recorded(data, {**scope, 'plan': True}, config)
        self.assertEqual(none, [])
        self.assertEqual(set(plan), {'plan', 'sampled', 'seed'})
        self.assertEqual([e['id'] for e in plan['plan']], calls)
        self.assertEqual((plan['sampled'], plan['seed']), (fresh['sampled'], fresh['seed']))
        self.assertEqual(plan['plan'][0], {'id': calls[0], 'source': 'logic.py', 'line': plan['plan'][0]['line'], 'kind': 'run', 'estimateMs': 1001})
        # Targeted units first, as in a run.
        _, calls = self.recorded(data, {'targeted': [uid], 'changed': {'logic.py': ''}}, config)
        plan = mutate(self.root, data, {'targeted': [uid], 'changed': {'logic.py': ''}, 'plan': True}, config)
        self.assertEqual([e['id'] for e in plan['plan']], calls)
        # A reused row keeps its place; a site no test covers is planned as no-coverage.
        reuse = {calls[0]: {**fresh['mutants'][0], 'id': calls[0], 'status': 'killed'}}
        plan = mutate(self.root, data, {**scope, 'reuse': reuse, 'plan': True}, config)
        self.assertEqual([(e['kind'], e['estimateMs']) for e in plan['plan']][0], ('reused', 0))
        data['coverage']['byTest'][uid] = {'logic.py': '1'}
        plan = mutate(self.root, data, {**scope, 'plan': True}, config)
        self.assertEqual({(e['kind'], e['estimateMs']) for e in plan['plan']}, {('no-coverage', 0)})

    def test_plan_function_variants_follow_the_run(self):
        data = self.input(self.BRANCH, 'from logic import value\ndef test_value():\n    assert value(1)\n', '1-4')
        scope = {'functions': True, 'changed': {'logic.py': ''}}
        config = {'mutation': {'maxMutants': 10, 'maxSeconds': 20, 'seed': 3}}
        _, calls = self.recorded(data, scope, config)
        plan = mutate(self.root, data, {**scope, 'plan': True}, config)
        self.assertEqual([e['id'] for e in plan['plan']], calls)
        self.assertEqual(len(calls), 2)
        self.assertEqual(plan['plan'][1]['after'], plan['plan'][0]['id'])
        killed = {calls[0]: {'id': calls[0], 'source': 'logic.py', 'line': 2, 'operator': 'body-replace', 'status': 'killed'}}
        plan = mutate(self.root, data, {**scope, 'plan': True, 'reuse': killed}, config)
        self.assertEqual([e['kind'] for e in plan['plan']], ['reused'])

    def test_plan_history_overrides_the_estimate(self):
        data = self.input(self.BRANCH, 'from logic import value\ndef test_value():\n    assert value(1)\n', '1-4')
        data['tests'][0]['durationsMs'] = [30, 10, 20, 40]
        scope = {'changed': {'logic.py': ''}, 'plan': True}
        config = {'mutation': {'maxMutants': 2, 'maxSeconds': 20, 'seed': 3}}
        first, second = mutate(self.root, data, scope, config)['plan']
        self.assertEqual((first['estimateMs'], second['estimateMs']), (1025, 1025))
        again = mutate(self.root, data, {**scope, 'history': {second['id']: 4321}}, config)['plan']
        self.assertEqual([e['estimateMs'] for e in again], [1025, 4321])

    def test_plan_ignores_max_seconds_for_the_choice(self):
        import itertools
        from types import SimpleNamespace
        data = self.input(self.BRANCH, 'from logic import value\ndef test_value():\n    assert value(1)\n', '1-4')
        scope = {'changed': {'logic.py': ''}}
        config = {'mutation': {'maxMutants': 3, 'maxSeconds': 1, 'seed': 3}}
        expected = mutate(self.root, data, {**scope, 'plan': True}, config)
        clock = itertools.count(0, 1000)
        late = SimpleNamespace(monotonic=lambda: float(next(clock)), monotonic_ns=lambda: next(clock))
        with patch('vibernt_cupel.mutation_run.time', late):
            planned = mutate(self.root, data, {**scope, 'plan': True}, config)
            ran, calls = self.recorded(data, scope, config)
        self.assertEqual(planned, expected)
        self.assertEqual(len(planned['plan']), 3)
        self.assertEqual((ran['mutants'], calls), ([], []))

    def test_only_runs_the_listed_ids_and_targets_only_them(self):
        data = self.input(self.BRANCH, 'from logic import value\ndef test_value():\n    assert value(1)\n', '1-4')
        uid = data['tests'][0]['id']
        scope = {'targeted': [uid]}
        config = {'mutation': {'maxMutants': 20, 'maxSeconds': 20, 'seed': 3}}
        plan = mutate(self.root, data, {**scope, 'plan': True}, config)['plan']
        self.assertEqual(len(plan), 8)
        ids = [e['id'] for e in plan]
        wanted = [ids[5], ids[2]]
        sliced, calls = self.recorded(data, {**scope, 'only': wanted}, config)
        self.assertEqual(calls, [ids[2], ids[5]])
        self.assertEqual({m['id'] for m in sliced['mutants']}, set(wanted))
        self.assertEqual(sliced['targeted'], [uid])
        self.assertFalse(sliced['sampled'])
        rest, calls = self.recorded(data, {**scope, 'only': [i for i in ids if i not in wanted]}, config)
        self.assertEqual(len(calls), 6)
        self.assertEqual(rest['targeted'], [uid])
        failing, _ = self.recorded(data, {**scope, 'only': wanted}, config, status='error')
        self.assertEqual(failing['targeted'], [])
        # Faults the plan left out (cap) still keep the unit from being targeted.
        small = {'mutation': {**config['mutation'], 'maxMutants': 4}}
        some = [e['id'] for e in mutate(self.root, data, {**scope, 'plan': True}, small)['plan']]
        capped, calls = self.recorded(data, {**scope, 'only': some}, small)
        self.assertEqual(calls, some)
        self.assertEqual(capped['targeted'], [])
        self.assertTrue(capped['sampled'])
        with self.assertRaises(ValueError):
            mutate(self.root, data, {**scope, 'only': ['logic.py:9:1:nope:0']}, small)
        # No-coverage rows listed in only are emitted without a run.
        data['coverage']['byTest'][uid] = {'logic.py': '1'}
        bare = [e['id'] for e in mutate(self.root, data, {'changed': {'logic.py': ''}, 'plan': True}, config)['plan']]
        uncovered, calls = self.recorded(data, {'changed': {'logic.py': ''}, 'only': bare[:2]}, config)
        self.assertEqual(calls, [])
        self.assertEqual([m['status'] for m in uncovered['mutants']], ['no-coverage', 'no-coverage'])
        self.assertTrue(all('durationMs' not in m for m in uncovered['mutants']))

    def test_reused_row_in_only_is_copied(self):
        data = self.input(self.BRANCH, 'from logic import value\ndef test_value():\n    assert value(1)\n', '1-4')
        scope = {'changed': {'logic.py': ''}}
        config = {'mutation': {'maxMutants': 2, 'maxSeconds': 20, 'seed': 3}}
        ids = [e['id'] for e in mutate(self.root, data, {**scope, 'plan': True}, config)['plan']]
        row = {'id': ids[0], 'source': 'logic.py', 'line': 2, 'operator': 'x', 'status': 'killed', 'note': 'earlier'}
        sliced, calls = self.recorded(data, {**scope, 'only': [ids[0]], 'reuse': {ids[0]: row}}, config)
        self.assertEqual((sliced['mutants'], calls), ([row], []))

    def test_duration_on_rows_that_ran(self):
        data = self.input(self.BRANCH, 'from logic import value\ndef test_value():\n    assert value(1)\n', '1-4')
        scope = {'changed': {'logic.py': ''}}
        config = {'mutation': {'maxMutants': 2, 'maxSeconds': 20, 'seed': 3}}
        plain, _ = self.recorded(data, scope, config)
        self.assertTrue(all('durationMs' not in m for m in plain['mutants']))
        timed, _ = self.recorded(data, {**scope, 'timings': True}, config, pause=.03)
        self.assertEqual([{k: v for k, v in m.items() if k != 'durationMs'} for m in timed['mutants']], plain['mutants'])
        self.assertTrue(all(isinstance(m['durationMs'], int) and m['durationMs'] >= 25 for m in timed['mutants']))
        ids = [e['id'] for e in mutate(self.root, data, {**scope, 'plan': True}, config)['plan']]
        sliced, _ = self.recorded(data, {**scope, 'only': ids[:1]}, config, pause=.03)
        self.assertGreaterEqual(sliced['mutants'][0]['durationMs'], 25)

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
