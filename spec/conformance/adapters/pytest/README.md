# pytest adapter fixture

Run `python -m vibernt_cupel collect --root . --runs 1 -- -q` here, or run the adapter conformance command with `--fixtures` pointed at a directory containing this fixture alone. The `expected.json` uses SPEC section 16 partial-object matching.

| Part | Rule proved |
|---|---|
| `OFFSET` and function declarations in `src/math.py` | Module loading enters `setup` (K3) |
| `module_value` | Module-scoped fixture enters `setup` (K3) |
| `function_value` | Function-scoped fixture enters its test's `byTest` (K3) |
| Three `test_classify` parameter rows | Distinct IDs, shared definition unit (K10) |
| `TestGrouped.test_add` | Class name uses ` > ` in ID (K10) |
| `cupel_critical` | Marker maps to critical tag, including strict-marker pytest runs |
| `uncalled`, comment and blank lines | Coverable source lines include uncalled code; comments and blanks do not (K1) |
| `tests/` exclusion | Whole-repository source scan excludes tests (K2) |

## Hand check of the expected line sets

Numbering `src/math.py` from 1: line 1 is a comment; line 2 assigns `OFFSET`; lines 3, 6 and 11 are blank; lines 4, 7 and 12 define functions; lines 5, 8, 9, 10 and 13 contain executable body code. Therefore `coverable` is `2,4-5,7-10,12-13`. Importing the module executes 2, 4, 7 and 12. The module-scoped fixture calls `add`, executing 5, so `setup` is `2,4-5,7,12`.

`test_add`'s function fixture calls `add`, covering 5 in its test bucket. The class test calls `add` and also covers 5. Every `classify` row checks the branch on 8; the negative row returns on 9, while zero and one return on 10. No test calls `uncalled`, so line 13 is coverable but absent from both coverage maps. These sets were determined from the source and control flow before checking the collector output.
