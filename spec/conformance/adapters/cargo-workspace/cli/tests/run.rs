#[test]
fn prints_secret() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_ws-cli"))
        .arg("sk-12345")
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "secret");
}
