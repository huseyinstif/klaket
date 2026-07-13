/**
 * Klaket JS/TS SDK — turn any video into LLM-ready data. Zero dependencies.
 *
 *   import { Klaket } from "klaket-sdk";
 *   const k = new Klaket();
 *   const result = await k.process("https://youtube.com/watch?v=...");
 */

export type JobStatus = "queued" | "processing" | "done" | "failed";

export interface Job {
  id: string;
  url: string;
  status: JobStatus;
  stage?: string;
  progress?: number;
  title?: string;
  duration?: number;
  error?: string;
  created_at: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
  words?: { word: string; start: number; end: number }[];
}

export interface Scene {
  index: number;
  start: number;
  end: number;
  keyframe: string;
  ocr?: string;
  description?: string;
}

export interface Chapter {
  index: number;
  start: number;
  end: number;
  title: string;
  segments: number;
}

export interface JobResult {
  id: string;
  url: string;
  title: string;
  duration: number;
  language: string;
  transcript: TranscriptSegment[];
  scenes: Scene[];
  chapters: Chapter[];
}

export interface SearchHit {
  type: "transcript" | "scene";
  start: number;
  end: number;
  text: string;
  speaker?: string;
  score: number;
}

export interface IngestOptions {
  language?: string;
  model?: "tiny" | "base" | "small" | "medium" | "large-v3";
  prompt?: string;
  num_speakers?: number;
  webhook_url?: string;
}

export class KlaketError extends Error {}

export class Klaket {
  constructor(
    private baseUrl: string = "http://localhost:8484",
    private apiKey: string = "",
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /** Queue a video; returns the job id. */
  async ingest(url: string, options: IngestOptions = {}): Promise<string> {
    const body = await this.request("POST", "/v1/ingest", { url, ...options });
    return body.id;
  }

  /** Queue many videos; returns the job ids. */
  async batch(urls: string[], options: IngestOptions = {}): Promise<string[]> {
    const body = await this.request("POST", "/v1/batch", { urls, ...options });
    return body.ids;
  }

  status(jobId: string): Promise<Job> {
    return this.request("GET", `/v1/jobs/${jobId}`);
  }

  /** The full LLM-ready result (transcript, scenes, chapters…). */
  result(jobId: string): Promise<JobResult> {
    return this.request("GET", `/v1/jobs/${jobId}/result`);
  }

  /** Find moments inside a processed video. */
  async search(jobId: string, query: string): Promise<SearchHit[]> {
    const body = await this.request(
      "GET",
      `/v1/jobs/${jobId}/search?q=${encodeURIComponent(query)}`,
    );
    return body.hits;
  }

  async delete(jobId: string): Promise<void> {
    await this.request("DELETE", `/v1/jobs/${jobId}`);
  }

  /** This month's video-minute usage (and quota, in cloud mode). */
  usage(): Promise<{ month: string; used_minutes: number; quota_minutes: number }> {
    return this.request("GET", "/v1/usage");
  }

  /** Block until the job finishes; throws on failure/timeout. */
  async wait(jobId: string, timeoutMs = 1_800_000, pollMs = 3_000): Promise<Job> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await this.status(jobId);
      if (job.status === "done") return job;
      if (job.status === "failed") throw new KlaketError(`job ${jobId} failed: ${job.error}`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new KlaketError(`job ${jobId} timed out`);
  }

  /** ingest + wait + result in one call. */
  async process(url: string, options: IngestOptions = {}): Promise<JobResult> {
    const jobId = await this.ingest(url, options);
    await this.wait(jobId);
    return this.result(jobId);
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return {};
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new KlaketError(payload.error ?? `Klaket API error (${res.status})`);
    return payload;
  }
}
