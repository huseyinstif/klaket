## What & why

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `docker compose up --build` works end-to-end
- [ ] New API surface documented in `docs/api.md`
- [ ] Tests added/updated (`go test ./...` in apps/api, `pytest` in apps/worker)
- [ ] Core pipeline stays keyless (model calls are opt-in and fail soft)
