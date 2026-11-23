pub fn looks_secret(text: &str) -> bool {
    text.starts_with("sk-") && text.len() > 4
}
