// Klaket API — job orchestration server.
// Accepts ingest requests, queues them on Redis, serves job status and results.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	queueKey   = "klaket:queue"
	cleanupKey = "klaket:cleanup"
	jobsSetKey = "klaket:jobs"
	jobKeyPfx  = "klaket:job:"
)

type server struct {
	rdb        *redis.Client
	dataDir    string
	authOn     bool   // KLAKET_AUTH=on -> API keys required (cloud mode)
	adminToken string // KLAKET_ADMIN_TOKEN -> enables /v1/admin endpoints
}

type ingestRequest struct {
	URL string `json:"url"`
	// Language hint for transcription ("auto" by default).
	Language string `json:"language,omitempty"`
	// Whisper model override for this job (falls back to the worker's default).
	Model string `json:"model,omitempty"`
	// Context hint for transcription (proper nouns, jargon) — improves accuracy.
	Prompt string `json:"prompt,omitempty"`
	// Speaker-count hint for diarization (0 = auto-detect).
	NumSpeakers int `json:"num_speakers,omitempty"`
	// Translate the transcript to this ISO 639-1 code (e.g. "en"); also emits
	// subtitles.<lang>.srt/vtt. Local Argos models — no API keys.
	TranslateTo string `json:"translate_to,omitempty"`
	// Optional callback: the worker POSTs the final job JSON here on done/failed.
	WebhookURL string `json:"webhook_url,omitempty"`
}

type batchRequest struct {
	URLs        []string `json:"urls"`
	Language    string   `json:"language,omitempty"`
	Model       string   `json:"model,omitempty"`
	Prompt      string   `json:"prompt,omitempty"`
	NumSpeakers int      `json:"num_speakers,omitempty"`
	TranslateTo string   `json:"translate_to,omitempty"`
	WebhookURL  string   `json:"webhook_url,omitempty"`
}

const batchMaxURLs = 100

var allowedModels = map[string]bool{
	"": true, "tiny": true, "base": true, "small": true, "medium": true, "large-v3": true,
}

var iso639 = regexp.MustCompile(`^[a-z]{2}$`)

func validJobOptions(model, prompt, translateTo string, numSpeakers int) string {
	if !allowedModels[model] {
		return "model must be one of: tiny, base, small, medium, large-v3"
	}
	if len(prompt) > 500 {
		return "prompt must be at most 500 characters"
	}
	if numSpeakers < 0 || numSpeakers > 32 {
		return "num_speakers must be between 0 and 32"
	}
	if translateTo != "" && !iso639.MatchString(translateTo) {
		return "translate_to must be a 2-letter ISO 639-1 code (e.g. \"en\")"
	}
	return ""
}

type job struct {
	ID        string  `json:"id"`
	URL       string  `json:"url"`
	Status    string  `json:"status"` // queued | processing | done | failed
	Stage     string  `json:"stage,omitempty"`
	Progress  float64 `json:"progress,omitempty"`
	Title     string  `json:"title,omitempty"`
	Duration  float64 `json:"duration,omitempty"`
	Error     string  `json:"error,omitempty"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at,omitempty"`
	apiKey    string  // owner key; never serialized
}

func main() {
	redisAddr := getenv("REDIS_ADDR", "localhost:6379")
	dataDir := getenv("DATA_DIR", "./data")
	addr := getenv("LISTEN_ADDR", ":8484")

	s := &server{
		rdb:        redis.NewClient(&redis.Options{Addr: redisAddr}),
		dataDir:    dataDir,
		authOn:     strings.EqualFold(getenv("KLAKET_AUTH", "off"), "on"),
		adminToken: os.Getenv("KLAKET_ADMIN_TOKEN"),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("POST /v1/ingest", s.handleIngest)
	mux.HandleFunc("POST /v1/batch", s.handleBatch)
	mux.HandleFunc("GET /v1/jobs", s.handleListJobs)
	mux.HandleFunc("GET /v1/jobs/{id}", s.handleGetJob)
	mux.HandleFunc("GET /v1/jobs/{id}/result", s.handleGetResult)
	mux.HandleFunc("GET /v1/jobs/{id}/files/{name}", s.handleGetFile)
	mux.HandleFunc("DELETE /v1/jobs/{id}", s.handleDeleteJob)
	mux.HandleFunc("GET /v1/jobs/{id}/search", s.handleSearch)
	mux.HandleFunc("GET /v1/usage", s.handleUsage)
	mux.HandleFunc("POST /v1/admin/keys", s.handleCreateKey)
	mux.HandleFunc("GET /v1/admin/keys", s.handleListKeys)
	mux.HandleFunc("POST /v1/waitlist", s.handleWaitlist)

	log.Printf("klaket-api listening on %s (redis=%s data=%s auth=%v)", addr, redisAddr, dataDir, s.authOn)
	if err := http.ListenAndServe(addr, cors(mux)); err != nil {
		log.Fatal(err)
	}
}

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := s.rdb.Ping(r.Context()).Err(); err != nil {
		httpError(w, http.StatusServiceUnavailable, "redis unreachable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) handleIngest(w http.ResponseWriter, r *http.Request) {
	var req ingestRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	req.URL = strings.TrimSpace(req.URL)
	if req.URL == "" {
		httpError(w, http.StatusBadRequest, "url is required")
		return
	}
	if !validWebhook(req.WebhookURL) {
		httpError(w, http.StatusBadRequest, "webhook_url must be http(s)")
		return
	}
	if msg := validJobOptions(req.Model, req.Prompt, req.TranslateTo, req.NumSpeakers); msg != "" {
		httpError(w, http.StatusBadRequest, msg)
		return
	}
	key, err := s.resolveKey(r)
	if err != nil {
		httpError(w, http.StatusUnauthorized, err.Error())
		return
	}
	if err := s.checkQuota(r, key); err != nil {
		httpError(w, http.StatusTooManyRequests, err.Error())
		return
	}

	id, err := s.enqueueJob(r.Context(), jobSpec{
		url: req.URL, language: req.Language, model: req.Model,
		prompt: req.Prompt, numSpeakers: req.NumSpeakers, translateTo: req.TranslateTo,
		webhook: req.WebhookURL, key: key,
	})
	if err != nil {
		httpError(w, http.StatusInternalServerError, "failed to enqueue job")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"id": id, "status": "queued"})
}

// handleBatch queues many URLs in one call. Quota is checked once up front;
// per-minute usage still accrues per processed job.
func (s *server) handleBatch(w http.ResponseWriter, r *http.Request) {
	var req batchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	urls := make([]string, 0, len(req.URLs))
	for _, u := range req.URLs {
		if u = strings.TrimSpace(u); u != "" {
			urls = append(urls, u)
		}
	}
	if len(urls) == 0 {
		httpError(w, http.StatusBadRequest, "urls is required")
		return
	}
	if len(urls) > batchMaxURLs {
		httpError(w, http.StatusBadRequest, fmt.Sprintf("too many urls (max %d)", batchMaxURLs))
		return
	}
	if !validWebhook(req.WebhookURL) {
		httpError(w, http.StatusBadRequest, "webhook_url must be http(s)")
		return
	}
	if msg := validJobOptions(req.Model, req.Prompt, req.TranslateTo, req.NumSpeakers); msg != "" {
		httpError(w, http.StatusBadRequest, msg)
		return
	}
	key, err := s.resolveKey(r)
	if err != nil {
		httpError(w, http.StatusUnauthorized, err.Error())
		return
	}
	if err := s.checkQuota(r, key); err != nil {
		httpError(w, http.StatusTooManyRequests, err.Error())
		return
	}

	ids := make([]string, 0, len(urls))
	for _, url := range urls {
		id, err := s.enqueueJob(r.Context(), jobSpec{
			url: url, language: req.Language, model: req.Model,
			prompt: req.Prompt, numSpeakers: req.NumSpeakers, translateTo: req.TranslateTo,
			webhook: req.WebhookURL, key: key,
		})
		if err != nil {
			httpError(w, http.StatusInternalServerError, "failed to enqueue batch")
			return
		}
		ids = append(ids, id)
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"ids": ids, "count": len(ids)})
}

func validWebhook(u string) bool {
	return u == "" || strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://")
}

type jobSpec struct {
	url, language, model, prompt, translateTo, webhook, key string
	numSpeakers                                             int
}

// enqueueJob stores and queues a single job, returning its id.
func (s *server) enqueueJob(ctx context.Context, spec jobSpec) (string, error) {
	id := newID()
	now := time.Now().UTC().Format(time.RFC3339)
	fields := map[string]any{
		"id": id, "url": spec.url, "status": "queued", "api_key": spec.key,
		"language": defaultStr(spec.language, "auto"), "created_at": now,
	}
	if spec.model != "" {
		fields["model"] = spec.model
	}
	if spec.prompt != "" {
		fields["prompt"] = spec.prompt
	}
	if spec.numSpeakers > 0 {
		fields["num_speakers"] = spec.numSpeakers
	}
	if spec.translateTo != "" {
		fields["translate_to"] = spec.translateTo
	}
	if spec.webhook != "" {
		fields["webhook_url"] = spec.webhook
	}
	pipe := s.rdb.TxPipeline()
	pipe.HSet(ctx, jobKeyPfx+id, fields)
	pipe.SAdd(ctx, jobsSetKey, id)
	pipe.LPush(ctx, queueKey, id)
	_, err := pipe.Exec(ctx)
	return id, err
}

// authorizeJob loads a job and verifies the caller may access it.
// In cloud mode a key only sees its own jobs.
func (s *server) authorizeJob(w http.ResponseWriter, r *http.Request, id string) (job, bool) {
	key, err := s.resolveKey(r)
	if err != nil {
		httpError(w, http.StatusUnauthorized, err.Error())
		return job{}, false
	}
	j, err := s.loadJob(r.Context(), id)
	if err != nil || (s.authOn && j.apiKey != key) {
		httpError(w, http.StatusNotFound, "job not found")
		return job{}, false
	}
	return j, true
}

func (s *server) handleGetJob(w http.ResponseWriter, r *http.Request) {
	j, ok := s.authorizeJob(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, j)
}

func (s *server) handleListJobs(w http.ResponseWriter, r *http.Request) {
	key, err := s.resolveKey(r)
	if err != nil {
		httpError(w, http.StatusUnauthorized, err.Error())
		return
	}
	ctx := r.Context()
	ids, err := s.rdb.SMembers(ctx, jobsSetKey).Result()
	if err != nil {
		httpError(w, http.StatusInternalServerError, "failed to list jobs")
		return
	}
	jobs := make([]job, 0, len(ids))
	for _, id := range ids {
		if j, err := s.loadJob(ctx, id); err == nil && (!s.authOn || j.apiKey == key) {
			jobs = append(jobs, j)
		}
	}
	sort.Slice(jobs, func(a, b int) bool { return jobs[a].CreatedAt > jobs[b].CreatedAt })
	writeJSON(w, http.StatusOK, map[string]any{"jobs": jobs})
}

// handleGetResult streams the assembled result.json produced by the worker.
func (s *server) handleGetResult(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := s.authorizeJob(w, r, id); !ok {
		return
	}
	path := filepath.Join(s.dataDir, "jobs", id, "result.json")
	w.Header().Set("Content-Type", "application/json")
	http.ServeFile(w, r, path)
}

// The Alpine image ships no system MIME table; media types are mapped
// explicitly (a wrong Content-Type breaks playback in some browsers).
var contentTypes = map[string]string{
	".mp4": "video/mp4", ".m4a": "audio/mp4", ".mp3": "audio/mpeg",
	".webm": "video/webm", ".wav": "audio/wav", ".ogg": "audio/ogg",
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
	".json": "application/json", ".md": "text/markdown; charset=utf-8",
	".srt": "text/plain; charset=utf-8", ".vtt": "text/vtt; charset=utf-8",
}

// handleGetFile serves job artifacts such as keyframe images.
func (s *server) handleGetFile(w http.ResponseWriter, r *http.Request) {
	id, name := r.PathValue("id"), r.PathValue("name")
	// Reject path traversal: artifact names are flat files.
	if name != filepath.Base(name) || strings.HasPrefix(name, ".") {
		httpError(w, http.StatusBadRequest, "invalid path")
		return
	}
	if _, ok := s.authorizeJob(w, r, id); !ok {
		return
	}
	if ct, ok := contentTypes[strings.ToLower(filepath.Ext(name))]; ok {
		w.Header().Set("Content-Type", ct)
	}
	http.ServeFile(w, r, filepath.Join(s.dataDir, "jobs", id, name))
}

// handleDeleteJob removes a job's state and asks the worker to delete its
// artifacts (the worker owns the files on the shared volume; the API runs as
// an unprivileged user and must not need write access there).
func (s *server) handleDeleteJob(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := s.authorizeJob(w, r, id); !ok {
		return
	}
	ctx := r.Context()
	pipe := s.rdb.TxPipeline()
	pipe.SRem(ctx, jobsSetKey, id)
	pipe.Del(ctx, jobKeyPfx+id)
	pipe.LPush(ctx, cleanupKey, id)
	if _, err := pipe.Exec(ctx); err != nil {
		httpError(w, http.StatusInternalServerError, "failed to delete job")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) loadJob(ctx context.Context, id string) (job, error) {
	if !validID(id) {
		return job{}, os.ErrNotExist
	}
	m, err := s.rdb.HGetAll(ctx, jobKeyPfx+id).Result()
	if err != nil || len(m) == 0 {
		return job{}, os.ErrNotExist
	}
	j := job{
		ID: m["id"], URL: m["url"], Status: m["status"], Stage: m["stage"],
		Title: m["title"], Error: m["error"],
		CreatedAt: m["created_at"], UpdatedAt: m["updated_at"],
		apiKey: m["api_key"],
	}
	json.Unmarshal([]byte(defaultStr(m["progress"], "0")), &j.Progress)
	json.Unmarshal([]byte(defaultStr(m["duration"], "0")), &j.Duration)
	return j, nil
}

// --- helpers ---

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func validID(id string) bool {
	if len(id) != 16 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func defaultStr(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}
