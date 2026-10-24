# Minitest adapter fixture

Run from the repository root:

```sh
ruby packages/cupel-ruby/bin/cupel-ruby collect --root spec/conformance/adapters/minitest --runs 1
```

`expected.json` was written from the source and K1/K3/K10 rules before comparing a collector run. `lib/math.rb` line 1 and blank lines are not coverable. Module declaration, constant assignment, method declarations, and executable method bodies give `2-3,5-6,9-11,13,17-18`. Loading covers `2-3,5,9,17`. `test_add` calls line 6. The generated negative test takes lines 10-11; the zero test takes lines 10 and 13. The uncalled method body on line 18 stays uncovered. `test/math_test.rb` is excluded from source scope. The two generated methods share the `define_method` name expression as unit `test/math_test.rb::MathTest > "test_classify_#{value}"`; the preceding `# cupel:critical` marks only `test_add`.

The expected file uses section 16 partial-object matching, so runtime patch version, durations and shape hashes are checked by dedicated tests rather than pinned here.
