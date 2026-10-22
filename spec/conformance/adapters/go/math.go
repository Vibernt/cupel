package fixture

var boot = initialize()

func initialize() int {
	return 7
}

func Choose(n int) int {
	if n < 0 {
		return -n
	}
	if n == 0 {
		return boot
	}
	return n + 1
}

func Never() int {
	return 42
}
