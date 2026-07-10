// API keys, quotas and usage metering.
//
// Self-host stays frictionless: with KLAKET_AUTH=off (default) every request
// is attributed to the pseudo key "self-host" and no quota applies. Cloud mode
// (KLAKET_AUTH=on) requires "Authorization: Bearer klk_..." keys, created via
// the admin endpoints which are protected by KLAKET_ADMIN_TOKEN.
package main

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	keysSetKey  = "klaket:keys"
	keyPfx      = "klaket:key:"
	usagePfx    = "klaket:usage:" // klaket:usage:<key>:<YYYY-MM> -> float minutes
	waitlistKey = "klaket:waitlist"
	selfHostKey = "self-host"
	keyTokenPfx = "klk_"
)

type apiKeyInfo struct {
	Token        string  `json:"token,omitempty"`
	Name         string  `json:"name"`
	QuotaMinutes float64 `json:"quota_minutes"` // 0 = unlimited
	UsedMinutes  float64 `json:"used_minutes"`
	CreatedAt    string  `json:"created_at"`
}

func usageMonthKey(key string) string {
	return fmt.Sprintf("%s%s:%s", usagePfx, key, time.Now().UTC().Format("2006-01"))
}

// resolveKey authenticates the request and returns the caller's key id.
func (s *server) resolveKey(r *http.Request) (string, error) {
	if !s.authOn {
		return selfHostKey, nil
	}
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !strings.HasPrefix(token, keyTokenPfx) {
		return "", fmt.Errorf("missing API key")
	}
	exists, err := s.rdb.Exists(r.Context(), keyPfx+token).Result()
	if err != nil || exists == 0 {
		return "", fmt.Errorf("invalid API key")
	}
	return token, nil
}

// checkQuota returns an error when the key's monthly video-minute quota is spent.
func (s *server) checkQuota(r *http.Request, key string) error {
	if key == selfHostKey {
		return nil
	}
	quotaStr, err := s.rdb.HGet(r.Context(), keyPfx+key, "quota_minutes").Result()
	if err != nil {
		return nil // key without quota metadata: treat as unlimited
	}
	quota, _ := strconv.ParseFloat(quotaStr, 64)
	if quota <= 0 {
		return nil
	}
	used, _ := s.rdb.Get(r.Context(), usageMonthKey(key)).Float64()
	if used >= quota {
		return fmt.Errorf("monthly quota exceeded (%.1f/%.1f video-minutes)", used, quota)
	}
	return nil
}

func (s *server) handleUsage(w http.ResponseWriter, r *http.Request) {
	key, err := s.resolveKey(r)
	if err != nil {
		httpError(w, http.StatusUnauthorized, err.Error())
		return
	}
	used, _ := s.rdb.Get(r.Context(), usageMonthKey(key)).Float64()
	var quota float64
	if key != selfHostKey {
		q, _ := s.rdb.HGet(r.Context(), keyPfx+key, "quota_minutes").Result()
		quota, _ = strconv.ParseFloat(q, 64)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"month":         time.Now().UTC().Format("2006-01"),
		"used_minutes":  used,
		"quota_minutes": quota, // 0 = unlimited
	})
}

// --- admin endpoints ---

func (s *server) adminOK(r *http.Request) bool {
	if s.adminToken == "" {
		return false // admin API disabled unless a token is configured
	}
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	return subtle.ConstantTimeCompare([]byte(got), []byte(s.adminToken)) == 1
}

func (s *server) handleCreateKey(w http.ResponseWriter, r *http.Request) {
	if !s.adminOK(r) {
		httpError(w, http.StatusForbidden, "admin token required")
		return
	}
	var req struct {
		Name         string  `json:"name"`
		QuotaMinutes float64 `json:"quota_minutes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Name) == "" {
		httpError(w, http.StatusBadRequest, "name is required")
		return
	}
	token := keyTokenPfx + newID() + newID() // 32 hex chars
	now := time.Now().UTC().Format(time.RFC3339)
	ctx := r.Context()
	pipe := s.rdb.TxPipeline()
	pipe.HSet(ctx, keyPfx+token, map[string]any{
		"name": req.Name, "quota_minutes": req.QuotaMinutes, "created_at": now,
	})
	pipe.SAdd(ctx, keysSetKey, token)
	if _, err := pipe.Exec(ctx); err != nil {
		httpError(w, http.StatusInternalServerError, "failed to store key")
		return
	}
	writeJSON(w, http.StatusCreated, apiKeyInfo{
		Token: token, Name: req.Name, QuotaMinutes: req.QuotaMinutes, CreatedAt: now,
	})
}

func (s *server) handleListKeys(w http.ResponseWriter, r *http.Request) {
	if !s.adminOK(r) {
		httpError(w, http.StatusForbidden, "admin token required")
		return
	}
	ctx := r.Context()
	tokens, _ := s.rdb.SMembers(ctx, keysSetKey).Result()
	keys := make([]apiKeyInfo, 0, len(tokens))
	for _, token := range tokens {
		m, err := s.rdb.HGetAll(ctx, keyPfx+token).Result()
		if err != nil || len(m) == 0 {
			continue
		}
		quota, _ := strconv.ParseFloat(m["quota_minutes"], 64)
		used, _ := s.rdb.Get(ctx, usageMonthKey(token)).Float64()
		keys = append(keys, apiKeyInfo{
			// Expose only a token prefix in listings.
			Token: token[:len(keyTokenPfx)+8] + "…",
			Name:  m["name"], QuotaMinutes: quota, UsedMinutes: used, CreatedAt: m["created_at"],
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"keys": keys})
}

// --- waitlist (public, for the landing page) ---

func (s *server) handleWaitlist(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	email := strings.TrimSpace(strings.ToLower(req.Email))
	if len(email) < 6 || len(email) > 200 || strings.Count(email, "@") != 1 || strings.Contains(email, " ") {
		httpError(w, http.StatusBadRequest, "enter a valid email address")
		return
	}
	if err := s.rdb.SAdd(r.Context(), waitlistKey, email).Err(); err != nil {
		httpError(w, http.StatusInternalServerError, "failed to save")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
