#!/usr/bin/env node
/**
 * Klaket MCP server — lets AI agents "watch" videos.
 *
 * Wraps the Klaket REST API (self-hosted or cloud) as MCP tools over stdio.
 * Configure with KLAKET_API_URL (default http://localhost:8484).
 *
 * Example (Claude Code):
 *   claude mcp add klaket -- npx klaket-mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API = (process.env.KLAKET_API_URL ?? "http://localhost:8484").replace(/\/$/, "");

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${API}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Klaket API error (${res.status})`);
  return body;
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

type Scene = {
  index: number; start: number; end: number;
  keyframe: string; ocr?: string; description?: string;
};
type Segment = { start: number; end: number; text: string; speaker?: string };

function timecode(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return h > 0 ? `${String(h).padStart(2, "0")}:${mm}` : mm;
}

/** Render result.json as compact, LLM-friendly markdown. */
function renderResult(r: any): string {
  const chapters = (r.chapters ?? []) as Array<{ start: number; end: number; title: string }>;
  const lines: string[] = [
    `# ${r.title || r.id}`,
    `Duration ${timecode(r.duration)} · language ${r.language} · ${r.scenes.length} scenes`,
    ...(chapters.length > 0
      ? ["", "## Chapters", ...chapters.map((c) => `- [${timecode(c.start)}–${timecode(c.end)}] ${c.title}`)]
      : []),
    "",
    "## Transcript",
    ...(r.transcript.length === 0 ? ["(no speech detected)"] : []),
    ...r.transcript.map(
      (seg: Segment) =>
        `[${timecode(seg.start)}–${timecode(seg.end)}]${seg.speaker ? ` ${seg.speaker}:` : ""} ${seg.text}`,
    ),
    "",
    "## Scenes",
    ...r.scenes.map((sc: Scene) => {
      let line = `- Scene ${sc.index} [${timecode(sc.start)}–${timecode(sc.end)}]`;
      if (sc.description) line += ` — ${sc.description}`;
      if (sc.ocr) line += ` — on-screen text: "${sc.ocr}"`;
      return line;
    }),
  ];
  return lines.join("\n");
}

const server = new McpServer({ name: "klaket", version: "0.7.0" });

server.tool(
  "klaket_ingest",
  "Start processing a video (URL or server-side file path) into LLM-ready data. " +
    "Returns a job id — poll klaket_job_status until status is 'done', then call klaket_get_result.",
  { url: z.string().describe("Video URL (YouTube, direct file) or a path visible to the Klaket worker") },
  async ({ url }) => {
    const job = await api("/v1/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    return text(`Job queued: ${job.id}. Poll klaket_job_status with this id until it is done.`);
  },
);

server.tool(
  "klaket_job_status",
  "Check the status of a Klaket ingest job (queued | processing | done | failed).",
  { id: z.string().describe("Job id returned by klaket_ingest") },
  async ({ id }) => {
    const j = await api(`/v1/jobs/${id}`);
    const progress = j.progress ? ` ${Math.round(j.progress * 100)}%` : "";
    const detail = j.status === "failed" ? ` — error: ${j.error}` : ` — stage: ${j.stage ?? "-"}${progress}`;
    return text(`${j.id}: ${j.status}${detail}`);
  },
);

server.tool(
  "klaket_get_result",
  "Get the processed video as LLM-ready markdown: timestamped transcript, scene list " +
    "with descriptions and on-screen text. Only works when the job status is 'done'.",
  { id: z.string().describe("Job id of a completed job") },
  async ({ id }) => text(renderResult(await api(`/v1/jobs/${id}/result`))),
);

server.tool(
  "klaket_find_moment",
  "Search inside a processed video: finds the moments (timestamped transcript lines, " +
    "on-screen text or scene descriptions) matching a query. Job must be 'done'.",
  {
    id: z.string().describe("Job id of a completed job"),
    query: z.string().describe("What to look for, e.g. 'docker compose command' or 'pricing slide'"),
  },
  async ({ id, query }) => {
    const res = await api(`/v1/jobs/${id}/search?q=${encodeURIComponent(query)}`);
    if (!res.hits?.length) return text(`No moments matching "${query}" found in job ${id}.`);
    const lines = res.hits.map(
      (h: { type: string; start: number; end: number; text: string; speaker?: string }) =>
        `- [${timecode(h.start)}–${timecode(h.end)}] (${h.type}${h.speaker ? ` ${h.speaker}` : ""}) ${h.text}`,
    );
    return text(`Moments matching "${query}":\n${lines.join("\n")}`);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
