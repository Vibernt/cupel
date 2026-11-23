pub mod secrets;
#[cfg(target_arch = "wasm32")]
mod wasm_only;

pub fn halve(n: i32) -> i32 {
    if n % 2 != 0 {
        panic!("odd");
    }
    n / 2
}

#[cfg(test)]
mod tests {
    use super::halve;

    #[test]
    #[should_panic(expected = "odd")]
    fn odd_panics() {
        halve(3);
    }

    #[test]
    fn even() {
        assert_eq!(halve(4), 2);
    }

    #[ignore]
    #[test]
    fn slow() {
        assert_eq!(halve(8), 4);
    }

    #[test]
    fn reads_data_from_package_dir() {
        let text = std::fs::read_to_string("data/greeting.txt").unwrap();
        assert_eq!(text.trim(), "hello");
    }
}
