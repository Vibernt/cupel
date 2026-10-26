pub fn value() -> i32 { 1 }

pub fn source_pins() {
    let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/outer/inner.rs")).unwrap();
    assert_eq!(source, include_str!("inner.rs"));
    assert_eq!(source.as_bytes(), include_bytes!("inner.rs"));
}

pub fn metadata() -> (&'static str, &'static str, u32, u32) {
    (file!(), module_path!(), line!(), column!())
}
