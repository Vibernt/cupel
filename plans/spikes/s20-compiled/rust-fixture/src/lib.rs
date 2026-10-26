fn value() -> i32 { 1 }

#[test]
fn behavior() {
    assert_eq!(value(), 1);
}

#[test]
fn runtime_source_pin() {
    let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs")).unwrap();
    assert_eq!(source.lines().next(), Some("fn value() -> i32 { 1 }"));
}

#[test]
fn include_relative_pin() {
    assert_eq!(include_str!("lib.rs").lines().next(), Some("fn value() -> i32 { 1 }"));
}

#[test]
fn include_manifest_pin() {
    let source = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"));
    assert_eq!(source.lines().next(), Some("fn value() -> i32 { 1 }"));
}

#[test]
fn include_bytes_pin() {
    let source = include_bytes!("lib.rs");
    let needle = b"fn value() -> i32 { 1 }";
    assert!(source.starts_with(needle));
}

#[test]
fn source_path_macro() {
    assert!(file!().ends_with("src/lib.rs"));
}
