# Ruby and Minitest collector

Cupel auto-detects a Ruby project when it has a `Gemfile` and at least one `test/**/*_test.rb`, with no Node or pytest tests. It runs `packages/cupel-ruby/bin/cupel-ruby` as an external collector. Ruby and your project's Minitest must already be installed; Cupel does not install gems or call the network.

Run directly:

```sh
ruby packages/cupel-ruby/bin/cupel-ruby collect --root /path/to/project --runs 2 --out /path/to/input.json
```

After `--`, supply test files or a test command:

```sh
ruby packages/cupel-ruby/bin/cupel-ruby collect --root /path/to/project -- test/models/user_test.rb
ruby packages/cupel-ruby/bin/cupel-ruby collect --root /path/to/project -- rake test
RAILS_ENV=test ruby packages/cupel-ruby/bin/cupel-ruby collect --root /path/to/rails-app -- bin/rails test
```

For Rails, set `RAILS_ENV=test` and use `bin/rails test` or `rake test` so the app boots in its normal test environment. An explicit `cupel.json` `runners.minitest.collector` command can select the same external collector for a mixed-language repository. Re-check a test unit with `--recheck 'test/models/user_test.rb::UserTest > test_name'`; generated rows share a `file::@line` unit. The collector runs each selected row alone and records `coverage.rechecked` after successful isolation.

The preload starts Ruby `Coverage` before application files load. It attributes method-loading coverage to `setup` and per-test setup, body, and teardown coverage to that test. It excludes `test/`, `spec/`, `vendor/`, gems, and dot-directories from source scope. A `# cupel:critical` comment immediately before a test definition adds the `critical` tag. The collector reads test sources for shapes, text-pin brittleness, and interpreter spawn markers; it does not mutate files or run mutation analysis.
