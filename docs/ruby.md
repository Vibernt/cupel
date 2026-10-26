# Ruby and Minitest collector

**Bounded preview**, within the [support matrix](support.md). The MRI Ruby 4.0.7 / Minitest 6.0.0 direct-file
profile has source and installed fixture acceptance; **real-repository
acceptance is unrun**. It is not core first-release language support. Native
selective PR execution is unsupported and outside the supported first release.

Cupel auto-detects a Ruby project when it has a `Gemfile` and at least one `test/**/*_test.rb`, including alongside other detected runners. The npm CLI runs its checked-in `ruby/bin` and `ruby/lib` copy of the native runtime; that copy is byte-identical to the canonical `packages/cupel-ruby/bin` and `lib` tree. Ruby and your project's Minitest must already be installed; Cupel does not install gems or call the network.

Run directly:

```sh
ruby packages/cupel-ruby/bin/cupel-ruby collect --root /path/to/project --runs 2 --out /path/to/input.json
```

After `--`, supply test files. The collector also has command-loader experiments;
the Rails/Rake examples below are **outside the supported direct-file preview
full-guard profile**:

```sh
ruby packages/cupel-ruby/bin/cupel-ruby collect --root /path/to/project -- test/models/user_test.rb
ruby packages/cupel-ruby/bin/cupel-ruby collect --root /path/to/project -- rake test
RAILS_ENV=test ruby packages/cupel-ruby/bin/cupel-ruby collect --root /path/to/rails-app -- bin/rails test
```

Rails/Rake collection alone does not establish mutation or guard support. An explicit `cupel.json` `runners.minitest.collector` command can select the same external collector for a mixed-language repository. Re-check a test unit with `--recheck 'test/models/user_test.rb::UserTest > test_name'`; generated rows share a `file::@line` unit. The collector runs each selected row alone and records `coverage.rechecked` after successful isolation.

The preload starts Ruby `Coverage` before application files load. It attributes method-loading coverage to `setup` and per-test setup, body, and teardown coverage to that test. It excludes `test/`, `spec/`, `vendor/`, gems, and dot-directories from source scope. A `# cupel:critical` comment immediately before a test definition adds the `critical` tag. The collector reads test sources for shapes, text-pin brittleness, and interpreter spawn markers; it does not mutate files or run mutation analysis. Each source record includes a SHA-256 of its raw bytes.

## Mutation and confirmation

The native mutation backend is pinned to MRI Ruby **4.0.7** and Minitest **6.0.0**. It uses the same direct test-file load, `-Itest`, `-Ilib`, optional `-Ispec`, Bundler environment, and Minitest name selection as collection. It requires canonical source hashes and per-test coverage from a current input. It explicitly refuses file-level coverage, source changes, linked or symlinked source files, unsupported `load` and wrapped `load`, and any selected test that cannot be isolated. It does not claim Rails, Rake, custom loaders, or selective PR execution.

Live `cupel report`, `check`, and `guard` can run this backend for the `minitest` runner. An explicit `runners.minitest.collector` must end in `collect` so the same command prefix can run `mutate` and `confirm`; Cupel does not substitute another Ruby command. `--no-mutation` is the explicit coverage-only option. Keep the npm runtime copy current with `node scripts/sync-ruby-runtime.mjs`; `scripts/ruby-runtime-parity.test.mjs` fails if bin/lib paths or bytes drift. The package smoke runs the installed artifact with `CUPEL_REQUIRE_RUBY_SMOKE=1` as a required local gate.

Provide scope and optional config as JSON files. `scope` accepts `critical`, `changed`, and `targeted`, matching the shared mutation scope contract. For example:

```json
{"changed":{"lib/math.rb":""},"targeted":["test/math_test.rb::MathTest > test_add"]}
```

```sh
ruby packages/cupel-ruby/bin/cupel-ruby mutate --root /path/to/project --input /path/to/input.json --scope /path/to/scope.json --config /path/to/cupel.json --out /path/to/mutation.json
ruby packages/cupel-ruby/bin/cupel-ruby confirm --root /path/to/project --input /path/to/input.json --mutation /path/to/mutation.json --ids ruby:example-id --out /path/to/confirmed.json
```

Both commands output a standalone standard `mutation` object (`mutants`, `targeted`, `seed`, `sampled`), for a caller to attach to its input. `--ids` accepts comma-separated mutant ids. A mutation runs only baseline-passed tests that covered the site; a kill needs a reported Minitest failure. Runtime errors, unsupported loads and test-process crashes do not earn kills. A timeout counts only after a fresh load receipt, a passing unmutated probe, and a second timed-out mutant run with a larger limit. A survivor confirmation runs the mutant twice more and checks its original site metadata. Source bytes are never changed for mutation; the replacement is compiled in memory under the original filename, and private temporary specs are removed after use.
