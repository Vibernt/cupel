fn main() {
    let arg = std::env::args().nth(1).unwrap_or_default();
    if ws_core::secrets::looks_secret(&arg) {
        println!("secret");
    } else {
        println!("plain");
    }
}
