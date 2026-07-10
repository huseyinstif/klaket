// In-video search: lexical scoring over the transcript, on-screen text and
// scene descriptions. Zero dependencies — embeddings-based semantic search is
// planned as an optional layer, this endpoint is the always-available baseline.
package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type resultDoc struct {
	Transcript []struct {
		Start   float64 `json:"start"`
		End     float64 `json:"end"`
		Text    string  `json:"text"`
		Speaker string  `json:"speaker,omitempty"`
	} `json:"transcript"`
	Scenes []struct {
		Index       int     `json:"index"`
		Start       float64 `json:"start"`
		End         float64 `json:"end"`
		Keyframe    string  `json:"keyframe"`
		OCR         string  `json:"ocr,omitempty"`
		Description string  `json:"description,omitempty"`
	} `json:"scenes"`
}

type searchHit struct {
	Type    string  `json:"type"` // transcript | scene
	Start   float64 `json:"start"`
	End     float64 `json:"end"`
	Text    string  `json:"text"`
	Speaker string  `json:"speaker,omitempty"`
	Score   float64 `json:"score"`
}

const maxSearchHits = 10

func (s *server) handleSearch(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		httpError(w, http.StatusBadRequest, "q parameter is required")
		return
	}
	if _, ok := s.authorizeJob(w, r, id); !ok {
		return
	}

	raw, err := os.ReadFile(filepath.Join(s.dataDir, "jobs", id, "result.json"))
	if err != nil {
		httpError(w, http.StatusNotFound, "result not ready")
		return
	}
	var doc resultDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		httpError(w, http.StatusInternalServerError, "corrupt result")
		return
	}

	hits := make([]searchHit, 0)
	for _, seg := range doc.Transcript {
		if score := scoreText(query, seg.Text); score > 0 {
			hits = append(hits, searchHit{
				Type: "transcript", Start: seg.Start, End: seg.End,
				Text: seg.Text, Speaker: seg.Speaker, Score: score,
			})
		}
	}
	for _, scene := range doc.Scenes {
		combined := strings.TrimSpace(scene.OCR + " " + scene.Description)
		if score := scoreText(query, combined); score > 0 {
			hits = append(hits, searchHit{
				Type: "scene", Start: scene.Start, End: scene.End,
				Text: combined, Score: score,
			})
		}
	}

	sort.Slice(hits, func(a, b int) bool { return hits[a].Score > hits[b].Score })
	if len(hits) > maxSearchHits {
		hits = hits[:maxSearchHits]
	}
	writeJSON(w, http.StatusOK, map[string]any{"query": query, "hits": hits})
}

// Turkish diacritic folding: searching "guvenlik" must find "güvenlik".
var trFold = strings.NewReplacer(
	"İ", "i", "I", "i", "ı", "i",
	"Ş", "s", "ş", "s", "Ğ", "g", "ğ", "g",
	"Ü", "u", "ü", "u", "Ö", "o", "ö", "o", "Ç", "c", "ç", "c",
	"Â", "a", "â", "a", "Î", "i", "î", "i", "Û", "u", "û", "u",
)

func fold(s string) string { return strings.ToLower(trFold.Replace(s)) }

// scoreText: diacritic-insensitive token matching + prefix + one-typo
// tolerance; bonus when the full query appears verbatim.
func scoreText(query, text string) float64 {
	foldedText := fold(text)
	foldedQuery := fold(query)
	tokens := strings.Fields(foldedQuery)
	if len(tokens) == 0 {
		return 0
	}
	words := strings.Fields(foldedText)
	matched := 0
	for _, token := range tokens {
		if strings.Contains(foldedText, token) || matchLoose(token, words) {
			matched++
		}
	}
	score := float64(matched) / float64(len(tokens))
	if matched > 0 && strings.Contains(foldedText, foldedQuery) {
		score += 0.5
	}
	return score
}

// matchLoose: prefix ("fiyat" → "fiyatlandırma") and typo tolerance ("bomab" → "bomba").
func matchLoose(token string, words []string) bool {
	for _, word := range words {
		if len(token) >= 4 && strings.HasPrefix(word, token) {
			return true
		}
		if len(token) >= 5 && withinOneEdit(token, word) {
			return true
		}
	}
	return false
}

// withinOneEdit: Levenshtein distance ≤ 1 (rune-based, single pass).
func withinOneEdit(a, b string) bool {
	ra, rb := []rune(a), []rune(b)
	if len(ra) > len(rb) {
		ra, rb = rb, ra
	}
	if len(rb)-len(ra) > 1 {
		return false
	}
	i, j, edits := 0, 0, 0
	for i < len(ra) && j < len(rb) {
		if ra[i] == rb[j] {
			i++
			j++
			continue
		}
		edits++
		if edits > 1 {
			return false
		}
		if len(ra) == len(rb) {
			i++
		}
		j++
	}
	return edits+(len(rb)-j) <= 1
}
