use cupel_cargo_fixture::choose;

#[test]
fn negative() {
    assert_eq!(choose(-2), 2);
}

// cupel:critical
#[test]
fn zero() {
    assert_eq!(choose(0), 7);
}

#[test]
fn positive() {
    assert_eq!(choose(2), 3);
}
