# Python and pytest

Cupel's Python adapter is `vibernt-cupel` in `packages/cupel-py`. It uses only the Python standard library. Python 3.10+ can import the package; collection needs Python 3.12+ because it uses `sys.monitoring`. pytest is supplied by your project and is imported only inside the pytest process. The adapter never installs anything or sends data to a network service.

From a Python project root, with `packages/cupel-py/src` on `PYTHONPATH` (or the package installed locally):

```sh
python3 -m vibernt_cupel collect --root . --runs 2 --out cupel-input.json -- -q
python3 -m vibernt_cupel list --root .
python3 -m vibernt_cupel select 'tests/test_math.py::test_add' --root .
python3 -m vibernt_cupel collect --recheck 'tests/test_math.py::@18' --out checked.json
```

`collect` and `select` write `cupel-spec/1` JSON to standard output unless `--out` is given. `list` writes a JSON object containing test ids, files, names, units for parametrized rows, and tier tags. Options after `--` go to pytest. `select` resolves Cupel ids, including `Class > method`, to pytest node ids and runs exactly those rows; it does not accept additional pytest selectors. `--recheck` accepts one or more unit ids; each unit runs alone in a separate pytest process, replacing the rows' coverage. `--runs` controls the number of complete suite passes used for durations (default two).

`@pytest.mark.cupel_critical`, `cupel_standard`, and `cupel_minor` map to the corresponding tags; the plugin registers them for `--strict-markers`. `xfail` is skipped and strict `xpass` is failed. A test's setup, call, teardown and function-scoped fixtures belong to `coverage.byTest`. Imports, collection, and session, module and class fixture setup belong to `coverage.setup` for the test file. Python subprocess and `os.exec*` launches of Python executables set `spawnsInterpreter`.

Sources include repository `*.py` files outside test directories, virtual environments, dependency directories and dot-directories. `conftest.py`, `test_*.py` and `*_test.py` are excluded. `cupel.json` `scope.include` and `scope.exclude` narrow this set. The Python K1 mapping uses `tokenize`: every line with a non-whitespace code token is coverable, including string content and uncalled definitions; comments, blank lines and standalone docstrings are excluded. `sys.monitoring` LINE events are intersected with those lines. This is a line-level Python analogue of K1; Python does not provide the JS collector's nested character ranges. Source hashes are SHA-256 of file bytes.

Shapes use the test definition from the `def` line through its end, masking string and number tokens before 4-token FNV-1a shingles. Brittleness findings use the S6 strict Python detector plus `cupel.json` patterns whose language is `python` (or have no language field).

Cupel CLI selects this collector automatically for a Python project with no node test files and a `pyproject.toml`, `pytest.ini`, or pytest section in `setup.cfg`. It adds the bundled package source to `PYTHONPATH` and runs `python3 -m vibernt_cupel collect`; `python3` must have pytest available. To choose an explicit interpreter, set a collector command in `cupel.json`:

```json
{ "runners": { "pytest": { "collector": "/path/to/python -m vibernt_cupel collect" } } }
```

The JS CLI runs external collectors at the repository root with `--root`, `--runs`, `--out`, and any re-check ids. Python mutation is not part of M6. The resulting input can be validated with `cupel validate cupel-input.json`.
