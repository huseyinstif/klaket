# Klaket API (v0.3)

Base URL (self-hosted): `http://localhost:8484`

## Authentication

- **Self-host (default):** `KLAKET_AUTH=off` — no keys, no quotas.
- **Cloud mode:** `KLAKET_AUTH=on` — every request needs `Authorization: Bearer klk_…`.
  Keys see only their own jobs; monthly video-minute quotas return `429` when spent.

### GET /v1/usage
`{ "month": "2026-07", "used_minutes": 0.76, "quota_minutes": 30 }` (0 = unlimited)

### Admin (requires `KLAKET_ADMIN_TOKEN` env + `Authorization: Bearer <token>`)
- `POST /v1/admin/keys` `{"name": "acme", "quota_minutes": 30}` → `201` with the full `klk_…` token (shown once)
- `GET /v1/admin/keys` → list (token prefixes only) with per-key usage

### POST /v1/waitlist (public)
`{"email": "you@company.com"}` → `{"ok": true}` — landing page signup.

## POST /v1/ingest

Queue a video for processing.

```jsonc
// request
{
  "url": "https://youtube.com/watch?v=...",  // or a worker-visible path like /data/samples/demo.mp4
  "language": "auto",                        // ISO 639-1 hint, or "auto" (default) — ~100 languages
  "model": "medium",                         // optional per-job Whisper model: tiny|base|small|medium|large-v3
  "prompt": "Klaket, Firecrawl, RAG",        // optional context hint (proper nouns/jargon, max 500 chars)
  "num_speakers": 2,                         // optional diarization hint (0 = auto)
  "translate_to": "en",                      // optional: translate transcript (local Argos models, keyless);
                                             //   adds transcript[].translated + subtitles.<lang>.srt/vtt
  "webhook_url": "https://your.app/hooks/klaket"  // optional: POSTed on done/failed
}

// 202 response
{ "id": "1f3a9c04d2e88b17", "status": "queued" }
```

Webhook payload: `{ "id", "status", "title", "duration", "error" }` — best-effort, 10s timeout, no retries (v0.4).

**Playlists:** a URL containing `list=` is expanded (no video download) into
individual child jobs that inherit the parent's options; the placeholder job
disappears once expansion completes. Cap: `KLAKET_PLAYLIST_LIMIT` (default 25, max 100).

## POST /v1/batch

Queue up to 100 URLs at once (quota is checked once up front):

```jsonc
{ "urls": ["https://...", "/data/samples/a.mp4"], "language": "auto", "webhook_url": "..." }
// 202 → { "ids": ["...", "..."], "count": 2 }
```

## GET /v1/jobs

List all jobs (newest first): `{ "jobs": [Job, ...] }`

## GET /v1/jobs/{id}

```jsonc
{
  "id": "1f3a9c04d2e88b17",
  "url": "...",
  "status": "processing",        // queued | processing | done | failed
  "stage": "transcribe",         // ingest | audio | transcribe | scenes | keyframes | assemble
  "progress": 0.30,
  "title": "...",                // filled when known
  "duration": 213.4,             // seconds
  "error": "",                   // set when failed
  "created_at": "2026-07-09T12:00:00Z",
  "updated_at": "2026-07-09T12:01:30Z"
}
```

## GET /v1/jobs/{id}/result

The assembled `result.json` (only after `status=done`):

```jsonc
{
  "id": "...", "url": "...", "title": "...",
  "duration": 213.4, "language": "en",
  "transcript": [
    {
      "start": 14.32, "end": 19.8, "text": "...",
      "speaker": "S1",                       // KLAKET_DIARIZE=on (default); omitted if diarization is off/failed
      "words": [ { "word": "...", "start": 14.32, "end": 14.6 } ]
    }
  ],
  "scenes": [
    {
      "index": 0, "start": 0.0, "end": 42.5, "keyframe": "scene_000.jpg",
      "ocr": "docker compose up",   // on-screen text (KLAKET_OCR=on, default)
      "description": ""             // filled when KLAKET_VLM is enabled (off by default)
    }
  ],
  "media_file": "source.mp4",                // artifact name to stream/serve (source.mp3 for audio)
  "chapters": [
    { "index": 0, "start": 0.0, "end": 42.5,
      "title": "So today we're deploying with docker…", "segments": 6 }
  ],
  "generated_at": "...", "klaket_version": "0.7.1"
}
```

`chapters` are auto-generated: one per scene, titled by the first overlapping
speech segment. **Audio-only inputs** (podcasts, mp3/m4a) have no scenes — the
visual stages are skipped and chapters are derived from speech pauses instead.

## GET /v1/jobs/{id}/search?q=…

Find moments inside a processed video (transcript lines, on-screen text, scene
descriptions). Diacritic-insensitive (`uber` finds `über`), prefix-aware
(`deploy` finds `deployment`) and typo-tolerant (one edit for tokens ≥5
chars: `kubernets` finds `kubernetes`). Top 10 hits:

```jsonc
{ "query": "docker compose", "hits": [
  { "type": "transcript", "start": 190.0, "end": 195.5,
    "speaker": "S1", "text": "…run docker compose up…", "score": 1.5 }
] }
```

## DELETE /v1/jobs/{id}

Removes the job and all its artifacts (`204`). The file cleanup is handled by the
worker asynchronously (it owns the data volume).

A markdown rendering is written next to it as `result.md` (not yet exposed over HTTP).

## GET /v1/jobs/{id}/files/{name}

Serves job artifacts: keyframe JPEGs, `result.md`, and subtitles
(`subtitles.srt`, `subtitles.vtt` — speaker-labeled when diarization is on).

## GET /healthz

`{ "status": "ok" }` when the API and Redis are reachable.
