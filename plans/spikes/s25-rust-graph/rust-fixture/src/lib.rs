mod outer;

#[test]
fn behavior() {
    assert_eq!(outer::value(), 1);
}

#[test]
fn source_and_macro_pins() {
    let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs")).unwrap();
    assert_eq!(source, include_str!("lib.rs"));
    assert_eq!(source.as_bytes(), include_bytes!("lib.rs"));
    outer::source_pins();
    println!("ROOT_META:{:?}", (file!(), module_path!(), line!(), column!()));
    println!("OUTER_META:{:?}", outer::metadata());
    println!("INNER_META:{:?}", outer::inner_metadata());
}
