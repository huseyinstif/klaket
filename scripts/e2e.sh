#!/usr/bin/env bash
# Klaket end-to-end smoke test.
# Usage: after `docker compose up -d`, run `bash scripts/e2e.sh` from the repo root
set -u

BASE="${KLAKET_API:-http://localhost:8484}"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $1"; }

check_status() { # name expected method url [body]
  local name=$1 want=$2 method=$3 url=$4 body=${5:-}
  local got
  if [ -n "$body" ]; then
    got=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' -d "$body" "$url")
  else
    got=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" "$url")
  fi
  if [ "$got" = "$want" ]; then ok "$name ($got)"; else bad "$name: got $got want $want"; fi
}

echo "== Klaket e2e =="

# --- validations ---
check_status "healthz"                 200 GET  "$BASE/healthz"
check_status "ingest without url"      400 POST "$BASE/v1/ingest" '{}'
check_status "invalid model"           400 POST "$BASE/v1/ingest" '{"url":"/x","model":"xl"}'
check_status "invalid translate_to"    400 POST "$BASE/v1/ingest" '{"url":"/x","translate_to":"ing"}'
check_status "invalid webhook"         400 POST "$BASE/v1/ingest" '{"url":"/x","webhook_url":"ftp://k"}'
check_status "batch empty strings"     400 POST "$BASE/v1/batch"  '{"urls":["",""]}'
check_status "nonexistent job"         404 GET  "$BASE/v1/jobs/aaaaaaaaaaaaaaaa"
check_status "admin closed w/o token"  403 POST "$BASE/v1/admin/keys" '{"name":"x"}'
check_status "waitlist invalid email"  400 POST "$BASE/v1/waitlist" '{"email":"abc"}'

# --- full flow: synthetic clip -> ingest -> done -> artifacts -> delete ---
if docker exec klaket-worker-1 sh -c 'ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=440:duration=6" -f lavfi -i color=c=teal:s=320x180:d=6 -map 1:v -map 0:a -pix_fmt yuv420p -shortest /data/samples/e2e.mp4'; then
  ok "synthetic clip generated"
else
  bad "synthetic clip generation failed"
fi

ID=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"url":"/data/samples/e2e.mp4"}' "$BASE/v1/ingest" \
     | grep -o '"id":"[0-9a-f]*"' | cut -d'"' -f4)
if [ -n "${ID:-}" ]; then ok "ingest accepted ($ID)"; else bad "ingest rejected"; fi

S=""
for _ in $(seq 1 60); do
  S=$(curl -s "$BASE/v1/jobs/$ID" | grep -o '"status":"[a-z]*"' | cut -d'"' -f4)
  if [ "$S" = "done" ] || [ "$S" = "failed" ]; then break; fi
  sleep 3
done
if [ "$S" = "done" ]; then ok "pipeline done"; else bad "pipeline status: ${S:-timeout}"; fi

RESULT=$(curl -s "$BASE/v1/jobs/$ID/result")
echo "$RESULT" | grep -q '"scenes"'   && ok "result: scenes field"   || bad "result: scenes missing"
echo "$RESULT" | grep -q '"chapters"' && ok "result: chapters field" || bad "result: chapters missing"
echo "$RESULT" | grep -q '"media_file"' && ok "result: media_file"   || bad "result: media_file missing"

check_status "subtitles.srt" 200 GET "$BASE/v1/jobs/$ID/files/subtitles.srt"
check_status "keyframe"      200 GET "$BASE/v1/jobs/$ID/files/scene_000.jpg"
check_status "search without q" 400 GET "$BASE/v1/jobs/$ID/search"
check_status "delete"           204 DELETE "$BASE/v1/jobs/$ID"
check_status "404 after delete" 404 GET "$BASE/v1/jobs/$ID"

echo
echo "TOTAL: $PASS PASS, $FAIL FAIL"
[ "$FAIL" -eq 0 ]
