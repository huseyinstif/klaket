# n8n-nodes-klaket

n8n community node for [Klaket](https://github.com/huseyinstif/klaket) — turn any video into LLM-ready data inside your workflows: word-timestamped transcripts (~100 languages), speaker labels, scenes + keyframes, on-screen text (OCR), chapters, SRT/VTT subtitles and in-video moment search. Fully local, no API keys.

## Installation

In n8n: **Settings → Community Nodes → Install** → `n8n-nodes-klaket`

You also need a running Klaket API (self-hosted, free):

```bash
git clone https://github.com/huseyinstif/klaket.git && cd klaket
docker compose up -d --build   # API on :8484
```

> n8n running in Docker? Set the credential's API URL to `http://host.docker.internal:8484` (or your host's address) instead of `localhost`.

## Credentials

**Klaket API** — just the API URL (default `http://localhost:8484`). API key only if you enabled `KLAKET_AUTH=on`.

## Operations

| Operation | What it does |
|---|---|
| **Ingest & Wait** | Queue a video and wait for the full LLM-ready result (transcript, scenes, chapters…) |
| **Ingest** | Queue a video, return the job ID immediately (pair with a webhook) |
| **Get Job Status** | Progress of a job (stage + percent) |
| **Get Result** | Result of a completed job |
| **Find Moment** | Search inside a processed video — diacritic-insensitive and typo-tolerant |

## Example workflow ideas

- **Meeting pipeline:** Webhook (recording URL) → Klaket *Ingest & Wait* → LLM summarize → post to Slack
- **YouTube watchlist:** RSS trigger → Klaket → store transcript chunks in a vector DB
- **Podcast subtitles:** Dropbox trigger → Klaket → email the SRT to your editor

MIT licensed.
