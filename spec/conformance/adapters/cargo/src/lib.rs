pub fn choose(n: i32) -> i32 {
    if n < 0 {
        return -n;
    }
    if n == 0 {
        return 7;
    }
    n + 1
}

pub fn never() -> i32 {
    42
}
