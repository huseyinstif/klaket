# CLAUDE.md — Klaket code guide

This file is for AI agents and developers working in this codebase. A detailed decision/change log lives in **MEMORY.md** — a local, gitignored dev log that is not part of the OSS project.

## Project summary
- **Klaket**: an open-source engine + cloud API that turns any video into **LLM-ready structured data**. ("Firecrawl for video")
- **Name story:** Klaket = the clapperboard; on a film set it syncs sound with image → Klaket syncs video with LLMs.
- **Business model (Firecrawl-style open-core):** OSS self-hosting is free; a minute-based, credit-metered cloud API is sold via the website.
- **Status:** v0.7 — pre-1.0; core pipeline plus OCR, diarization, translation, in-video search, chapters, MCP server and SDKs.

## Architecture
```
Client → Go API (apps/api) → Redis queue → Python worker (apps/worker) → /data/jobs/<id>/result.json
              ↑                                     │
     Dashboard (apps/dashboard) ────────────────────┘  (reads via the API)
```

### Pipeline stages (worker)
1. **ingest** — yt-dlp (URL) or a direct file
2. **audio** — 16kHz mono WAV via ffmpeg
3. **transcribe** — faster-whisper (local, NO LLM API)
4. **scenes** — PySceneDetect content-based scene detection
5. **keyframes** — one frame per scene via ffmpeg
6. **assemble** — a single timestamped `result.json` + `result.md`
- Optional local stages (still keyless): OCR (`KLAKET_OCR`), speaker diarization (`KLAKET_DIARIZE`), transcript translation (`translate_to`, Argos models).
- Pluggable model layer: VLM scene descriptions (`KLAKET_VLM` — local model / BYOK / cloud), off by default.
- **Principle:** the core pipeline (1–6) runs without any LLM/API key. The model layer is always an optional socket.

## Repo layout
```
klaket/
├── CLAUDE.md            # this file
├── MEMORY.md            # local dev log (gitignored, not part of the repo)
├── README.md            # public README
├── CONTRIBUTING.md      # contributor guide
├── LICENSE              # AGPL-3.0 (same model as Firecrawl)
├── docker-compose.yml   # redis + api + worker + dashboard
├── apps/
│   ├── api/             # Go 1.22+, stdlib router, Redis (go-redis)
│   ├── worker/          # Python 3.12, faster-whisper, scenedetect, yt-dlp
│   ├── dashboard/       # Vite + React + TS SPA
│   └── mcp/             # MCP server for agents (TypeScript)
├── sdks/                # Python + JS client SDKs
├── docs/                # api.md — the API contract
├── scripts/             # e2e.sh — end-to-end smoke test
└── samples/             # test videos (gitignored, never committed)
```

## Language/stack decisions (rationale in MEMORY.md)
- **API: Go** — high concurrency, single binary, small Docker image.
- **Worker: Python** — the ML ecosystem (whisper/scenedetect) forces it; the performance-critical work already happens inside ffmpeg/CTranslate2 (C++).
- **Dashboard: Vite + React + TypeScript** — no SSR needed, lightweight image (nginx).
- **Queue/state: Redis** — sufficient for now. Postgres (users/credits) arrives in the SaaS phase.

## Run / test
```powershell
cd C:\Users\stif\Desktop\klaket
docker compose up --build          # api :8484, dashboard :5180
# API smoke test:
curl -X POST localhost:8484/v1/ingest -d '{"url":"<video-url-or-file>"}'
curl localhost:8484/v1/jobs/<id>
# Full end-to-end smoke test (with the stack running):
bash scripts/e2e.sh
```

## Conventions
- Code + comments in **English** (public OSS repo).
- When the API contract changes, update `docs/api.md` in the same change.
- A **local** git commit after every meaningful step (Conventional Commits: `feat:`, `fix:`, `docs:`…).
- **UI/UX work is designed with the Stitch MCP first**, then implemented in code.

## Boundaries (autonomous work)
- **No paid actions, no push/publish** — everything stays local. Pushing to GitHub, domains, payments = the user's call.
- The user's API keys are never written into the repo.

## Roadmap
- **v0.1 (DONE):** lite pipeline (no LLM) + API + dashboard + docker compose; a working end-to-end demo.
- **v0.2 (DONE):** OCR, VLM scene descriptions (pluggable), MCP server.
- **v0.3 (DONE):** API keys + monthly video-minute quotas (Redis), /v1/usage, admin endpoints, waitlist. `KLAKET_AUTH=off` by default.
- **v0.4:** Stripe + Postgres (persistent users/credits), API keys/Usage pages in the dashboard, batch ingest, webhooks.
- **v1.0:** public GitHub launch (Show HN) + cloud beta.
