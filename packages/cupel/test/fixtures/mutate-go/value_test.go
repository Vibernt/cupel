package fixture

import (
	"os"
	"strings"
	"testing"
)

func TestChoose(t *testing.T) {
	if got := Choose(2); got != 3 {
		t.Fatalf("Choose(2) = %d, want 3", got)
	}
}

func TestIdentity(t *testing.T) {
	if got := Identity(2); got != 2 {
		t.Fatalf("Identity(2) = %d, want 2", got)
	}
}

func TestLabel(t *testing.T) {
	if got := Label(); got != "ab" {
		t.Fatalf("Label() = %q, want ab", got)
	}
}

func TestSourcePin(t *testing.T) {
	source, err := os.ReadFile("value.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(source), "func Choose(n int) int { return n + 1 }") {
		t.Fatal("source pin changed")
	}
}

func TestTamper(t *testing.T) {
	mode := os.Getenv("CUPEL_GO_TAMPER_MODE")
	if mode == "" {
		return
	}
	if mode == "after-first" {
		marker := os.Getenv("CUPEL_GO_TAMPER_MARKER")
		if marker == "" {
			t.Fatal("missing tamper marker")
		}
		if _, err := os.Stat(marker); os.IsNotExist(err) {
			if err := os.WriteFile(marker, []byte("first run complete"), 0600); err != nil {
				t.Fatal(err)
			}
			return
		} else if err != nil {
			t.Fatal(err)
		}
	}
	target := "value.go"
	if mode == "test-file" {
		target = "value_test.go"
	}
	f, err := os.OpenFile(target, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("\n// fixture changed source\n"); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}
