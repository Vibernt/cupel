use ws_core::secrets::looks_secret;

#[test]
fn detects_key() {
    assert!(looks_secret("sk-12345"));
}
