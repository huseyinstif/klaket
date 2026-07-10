package main

import (
	"encoding/hex"
	"testing"
)

func TestValidID(t *testing.T) {
	cases := []struct {
		id   string
		want bool
	}{
		{"ddb67b6d13aef23f", true},
		{"DDB67B6D13AEF23F", true}, // hex accepts uppercase
		{"ddb67b6d13aef23", false}, // 15 chars
		{"ddb67b6d13aef23f0", false},
		{"gggggggggggggggg", false}, // not hex
		{"", false},
		{"../../etc/passwd", false},
	}
	for _, c := range cases {
		if got := validID(c.id); got != c.want {
			t.Errorf("validID(%q) = %v, want %v", c.id, got, c.want)
		}
	}
}

func TestValidWebhook(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		{"", true}, // webhook is optional
		{"http://example.com/hook", true},
		{"https://example.com/hook", true},
		{"ftp://example.com", false},
		{"javascript:alert(1)", false},
		{"example.com/hook", false},
	}
	for _, c := range cases {
		if got := validWebhook(c.url); got != c.want {
			t.Errorf("validWebhook(%q) = %v, want %v", c.url, got, c.want)
		}
	}
}

func TestNewID(t *testing.T) {
	a, b := newID(), newID()
	if len(a) != 16 {
		t.Fatalf("newID length = %d, want 16", len(a))
	}
	if _, err := hex.DecodeString(a); err != nil {
		t.Fatalf("newID not hex: %v", err)
	}
	if a == b {
		t.Fatal("two newID calls returned the same value")
	}
	if !validID(a) {
		t.Fatal("newID output rejected by validID")
	}
}

func TestDefaultStr(t *testing.T) {
	if got := defaultStr("", "fallback"); got != "fallback" {
		t.Errorf("defaultStr empty = %q", got)
	}
	if got := defaultStr("value", "fallback"); got != "value" {
		t.Errorf("defaultStr non-empty = %q", got)
	}
}

func TestUsageMonthKey(t *testing.T) {
	key := usageMonthKey("klk_abc")
	if len(key) == 0 || key[:len(usagePfx)] != usagePfx {
		t.Errorf("usageMonthKey prefix wrong: %q", key)
	}
}
