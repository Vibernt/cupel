package fixture

import "testing"

func TestNegative(t *testing.T) {
	if got := Choose(-2); got != 2 {
		t.Fatalf("got %d", got)
	}
}

// cupel:critical
func TestZero(t *testing.T) {
	if got := Choose(0); got != 7 {
		t.Fatalf("got %d", got)
	}
}

func TestPositive(t *testing.T) {
	if got := Choose(2); got != 3 {
		t.Fatalf("got %d", got)
	}
}
