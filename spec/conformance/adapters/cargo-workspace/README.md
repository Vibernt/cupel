# Cargo workspace fixture

A dependency-free workspace for the collector rules a real workspace needs:

- `core/src/secrets.rs` is an ordinary Rust module and must be read.
- `core/src/lib.rs::tests > reads_data_from_package_dir` reads `data/greeting.txt`,
  so it passes only when run from its package directory, as Cargo runs it.
- `odd_panics` is `#[should_panic]`, and `slow` is `#[ignore]`.
- `cli/tests/run.rs` starts the `ws-cli` program, so `cli/src/main.rs` is covered
  only through a child process.
- `glue` has no tests; its lines still count as coverable and uncovered.
- `core/src/wasm_only.rs` compiles only for Wasm, so it is reported as not measured.
