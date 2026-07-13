package main

import "testing"

func TestFoldDiacritics(t *testing.T) {
	if got := fold("ÂÎÛ ŞIĞÜÖÇ şığüöç"); got != "aiu siguoc siguoc" {
		t.Errorf("fold result: %q", got)
	}
}

func TestScoreTextDiacriticInsensitive(t *testing.T) {
	// a query without diacritics must find diacritic-laden text
	if scoreText("munchen", "our trip to München last summer") == 0 {
		t.Error("diacritic folding is not working")
	}
	if scoreText("münchen", "the munchen travel vlog") == 0 {
		t.Error("folding in the reverse direction is not working")
	}
}

func TestScoreTextPrefix(t *testing.T) {
	if scoreText("deploy", "the new deployment pipeline") == 0 {
		t.Error("prefix matching is not working")
	}
	// an unrelated short token must not match
	if scoreText("xyz", "the new deployment pipeline") != 0 {
		t.Error("unrelated short token must not match")
	}
}

func TestScoreTextFuzzy(t *testing.T) {
	if scoreText("kubernets", "deploying to the kubernetes cluster") == 0 {
		t.Error("single-letter typo tolerance is not working")
	}
	if scoreText("xxxxx", "deploying to the kubernetes cluster") != 0 {
		t.Error("unrelated token must not match")
	}
}

func TestWithinOneEdit(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"camera", "camrea", false}, // transposition = 2 edits; unsupported (deliberate)
		{"camera", "camera", true},
		{"camera", "cameraa", true},
		{"camera", "cmera", true},
		{"camera", "banana", false},
	}
	for _, c := range cases {
		if withinOneEdit(c.a, c.b) != c.want {
			t.Errorf("withinOneEdit(%q,%q) != %v", c.a, c.b, c.want)
		}
	}
}
