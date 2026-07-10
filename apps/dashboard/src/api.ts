// Klaket API client. In docker the dashboard's nginx proxies /api -> api:8484.
const BASE = "/api";

export type Job = {
  id: string;
  url: string;
  status: "queued" | "processing" | "done" | "failed";
  stage?: string;
  progress?: number;
  title?: string;
  duration?: number;
  error?: string;
  created_at: string;
  updated_at?: string;
};

export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
  speaker?: string;
  words?: { word: string; start: number; end: number }[];
};
export type Scene = {
  index: number;
  start: number;
  end: number;
  keyframe: string;
  ocr?: string;
  description?: string;
};

export type Chapter = {
  index: number;
  start: number;
  end: number;
  title: string;
  segments: number;
};

export type JobResult = {
  id: string;
  url: string;
  title: string;
  duration: number;
  language: string;
  media_file?: string;
  transcript: TranscriptSegment[];
  scenes: Scene[];
  chapters?: Chapter[];
  generated_at: string;
};

export async function listJobs(): Promise<Job[]> {
  const res = await fetch(`${BASE}/v1/jobs`);
  if (!res.ok) throw new Error("failed to load jobs");
  return (await res.json()).jobs ?? [];
}

export async function getJob(id: string): Promise<Job> {
  const res = await fetch(`${BASE}/v1/jobs/${id}`);
  if (!res.ok) throw new Error("job not found");
  return res.json();
}

export async function getResult(id: string): Promise<JobResult> {
  const res = await fetch(`${BASE}/v1/jobs/${id}/result`);
  if (!res.ok) throw new Error("result not ready");
  return res.json();
}

export type IngestOptions = { model?: string; prompt?: string };

export async function ingest(url: string, options: IngestOptions = {}): Promise<{ id: string }> {
  const body: Record<string, string> = { url };
  if (options.model) body.model = options.model;
  if (options.prompt) body.prompt = options.prompt;
  const res = await fetch(`${BASE}/v1/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? "ingest failed");
  return res.json();
}

export async function searchJob(id: string, query: string) {
  const res = await fetch(`${BASE}/v1/jobs/${id}/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error("search failed");
  return (await res.json()).hits as {
    type: string; start: number; end: number; text: string; speaker?: string; score: number;
  }[];
}

export async function deleteJob(id: string): Promise<void> {
  const res = await fetch(`${BASE}/v1/jobs/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error("failed to delete job");
}

export const fileUrl = (jobId: string, name: string) =>
  `${BASE}/v1/jobs/${jobId}/files/${name}`;

export type Usage = { month: string; used_minutes: number; quota_minutes: number };

export async function getUsage(): Promise<Usage> {
  const res = await fetch(`${BASE}/v1/usage`);
  if (!res.ok) throw new Error("failed to load usage");
  return res.json();
}

export type AdminKey = {
  token?: string;
  name: string;
  quota_minutes: number;
  used_minutes: number;
  created_at: string;
};

async function adminFetch(path: string, adminToken: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${adminToken}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body;
}

export async function adminListKeys(adminToken: string): Promise<AdminKey[]> {
  return (await adminFetch("/v1/admin/keys", adminToken)).keys ?? [];
}

export async function adminCreateKey(
  adminToken: string, name: string, quotaMinutes: number,
): Promise<AdminKey> {
  return adminFetch("/v1/admin/keys", adminToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, quota_minutes: quotaMinutes }),
  });
}

export function timecode(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  return h > 0 ? `${h.toString().padStart(2, "0")}:${mm}` : mm;
}
