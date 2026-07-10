# Contributing to Klaket

Thanks for helping make video readable for LLMs. 🎬

## Dev setup

Everything runs in Docker — no local toolchain needed:

```bash
docker compose up --build
# api :8484 · dashboard :5180
```

Smoke test without waiting for a real download: generate a synthetic clip inside the
worker container (ffmpeg is bundled) and ingest its path:

```bash
docker exec klaket-worker-1 ffmpeg -f lavfi -i "testsrc2=size=640x360:d=10" \
  -f lavfi -i "sine=frequency=440:duration=10" -pix_fmt yuv420p /data/samples/t.mp4
curl -X POST localhost:8484/v1/ingest -d '{"url":"/data/samples/t.mp4"}'
```

## Repo layout

| Path | What | Stack |
|---|---|---|
| `apps/api` | Job orchestration API | Go (stdlib + go-redis) |
| `apps/worker` | Media pipeline | Python (ffmpeg, faster-whisper, PySceneDetect, RapidOCR) |
| `apps/dashboard` | Self-host dashboard | Vite + React + TS |
| `apps/mcp` | MCP server for agents | TypeScript |

## End-to-end smoke test

With the stack running, `bash scripts/e2e.sh` exercises the full flow
(validations → synthetic clip → ingest → artifacts → delete) and exits
non-zero on any failure. Run it before opening a PR that touches the
API or the pipeline.

## Ground rules

- **The core pipeline must stay keyless.** Anything that calls an external model API
  goes behind an opt-in env flag (see `KLAKET_VLM`) and must fail soft.
- Code and comments in English. Conventional Commits (`feat:`, `fix:`, `docs:`…).
- New API surface → update `docs/api.md` in the same PR.
- Keep dependencies lean — the worker image is heavy enough already.

## Reporting issues

Include the job's `error` field, worker logs (`docker compose logs worker`) and,
if possible, a URL or synthetic clip that reproduces the problem.
