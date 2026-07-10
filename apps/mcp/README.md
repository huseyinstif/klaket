# klaket-mcp

MCP server that gives AI agents eyes — they can "watch" any video through [Klaket](https://github.com/huseyinstif/klaket) and pull out transcripts, scenes, chapters and exact moments.

```bash
# Claude Code
claude mcp add klaket -- npx klaket-mcp
```

Requires a running Klaket API (self-host with `docker compose up` in the [main repo](https://github.com/huseyinstif/klaket) — no API keys needed). Set `KLAKET_API_URL` if it's not on `http://localhost:8484`, and `KLAKET_API_KEY` for cloud deployments.

## Tools

| Tool | What it does |
|---|---|
| `klaket_ingest` | Queue a video URL/path for processing |
| `klaket_job_status` | Check progress (stage + percent) |
| `klaket_get_result` | Fetch the LLM-ready result (transcript, scenes, chapters…) |
| `klaket_find_moment` | Find the exact moment something is said or shown |

Then just ask: *"Watch https://youtube.com/watch?v=… and summarize the commands the presenter runs."*

MIT licensed.
