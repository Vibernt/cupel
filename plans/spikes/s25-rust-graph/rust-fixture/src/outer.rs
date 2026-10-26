mod inner;

pub fn value() -> i32 { inner::value() }

pub fn source_pins() {
    let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/outer.rs")).unwrap();
    assert_eq!(source, include_str!("outer.rs"));
    assert_eq!(source.as_bytes(), include_bytes!("outer.rs"));
    inner::source_pins();
}

pub fn metadata() -> (&'static str, &'static str, u32, u32) {
    (file!(), module_path!(), line!(), column!())
}

pub fn inner_metadata() -> (&'static str, &'static str, u32, u32) { inner::metadata() }
