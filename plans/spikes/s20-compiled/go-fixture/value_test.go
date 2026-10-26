package proof

import (
	"os"
	"strings"
	"testing"
)

func TestBehavior(t *testing.T) {
	if got := value(); got != 1 {
		t.Fatalf("value() = %d, want 1", got)
	}
}

func TestSourcePin(t *testing.T) {
	source, err := os.ReadFile("value.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(source), "func value() int { return 1 }") {
		t.Fatal("source pin changed")
	}
}
