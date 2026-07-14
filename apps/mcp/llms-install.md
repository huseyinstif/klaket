# klaket-mcp — installation guide for AI agents

klaket-mcp is a **stdio** MCP server distributed on npm. It gives agents four tools to work with videos through a Klaket API: `klaket_ingest`, `klaket_job_status`, `klaket_get_result`, `klaket_find_moment`.

## Prerequisites

1. **Node.js >= 18** (the server runs via `npx`).
2. **A running Klaket API.** Self-host it with Docker:
   ```bash
   git clone https://github.com/huseyinstif/klaket.git && cd klaket
   docker compose up -d --build
   ```
   The API listens on `http://localhost:8484` by default. No API keys are required for local use.

## MCP configuration

Add this to the MCP settings file (e.g. `cline_mcp_settings.json` or any MCP client config):

```json
{
  "mcpServers": {
    "klaket": {
      "command": "npx",
      "args": ["-y", "klaket-mcp"],
      "env": {
        "KLAKET_API_URL": "http://localhost:8484"
      }
    }
  }
}
```

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `KLAKET_API_URL` | No | `http://localhost:8484` | Base URL of the Klaket API |
| `KLAKET_API_KEY` | No | (empty) | Bearer key, only for authenticated/cloud deployments |

## Verify the installation

1. The server should list 4 tools: `klaket_ingest`, `klaket_job_status`, `klaket_get_result`, `klaket_find_moment`.
2. Quick end-to-end check: call `klaket_ingest` with any YouTube URL, poll `klaket_job_status` until `done`, then `klaket_get_result`.
3. If tools fail with a connection error, the Klaket API is not running — start it with `docker compose up` (see prerequisites).
