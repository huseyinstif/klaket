package main

import "testing"

func TestFoldTurkish(t *testing.T) {
	if got := fold("Güvenliği ŞIĞÜÖÇ"); got != "guvenligi siguoc" {
		t.Errorf("fold result: %q", got)
	}
}

func TestScoreTextDiacriticInsensitive(t *testing.T) {
	// a query without diacritics must find diacritic-laden text
	if scoreText("guvenligi", "Güvenliği ulan üstündür Samuel'in.") == 0 {
		t.Error("diacritic folding is not working")
	}
	if scoreText("üstündür", "ustundur diye yazilmis") == 0 {
		t.Error("folding in the reverse direction is not working")
	}
}

func TestScoreTextPrefix(t *testing.T) {
	if scoreText("fiyat", "yeni fiyatlandırma tablosu") == 0 {
		t.Error("prefix matching is not working")
	}
	// an unrelated short token must not match
	if scoreText("fyi", "fiyatlandırma tablosu") != 0 {
		t.Error("unrelated short token must not match")
	}
}

func TestScoreTextFuzzy(t *testing.T) {
	if scoreText("bonba", "Bomba büyük ihtimalle yolda yerleştirildi") == 0 {
		t.Error("single-letter typo tolerance is not working")
	}
	if scoreText("xxxxx", "Bomba büyük ihtimalle") != 0 {
		t.Error("unrelated token must not match")
	}
}

func TestWithinOneEdit(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"bomba", "bomab", false}, // transposition = 2 edits; unsupported (deliberate)
		{"bomba", "bomba", true},
		{"bomba", "bombaa", true},
		{"bomba", "bmba", true},
		{"bomba", "banka", false},
	}
	for _, c := range cases {
		if withinOneEdit(c.a, c.b) != c.want {
			t.Errorf("withinOneEdit(%q,%q) != %v", c.a, c.b, c.want)
		}
	}
}
