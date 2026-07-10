import { useCallback, useEffect, useRef, useState } from "react";
import {
  adminCreateKey, adminListKeys, deleteJob, fileUrl, getJob, getResult, getUsage,
  ingest, listJobs, searchJob, timecode,
  type AdminKey, type Job, type JobResult, type Usage,
} from "./api";

/* ---------- helpers ---------- */

const SPEAKER_HUES = [215, 150, 280, 25, 330, 190, 45, 250];

/** Soft-toned speaker pill for the light theme. */
function speakerStyle(speaker: string): React.CSSProperties {
  const n = parseInt(speaker.replace(/\D/g, ""), 10) || 0;
  const hue = SPEAKER_HUES[n % SPEAKER_HUES.length];
  return { background: `hsl(${hue} 65% 93%)`, color: `hsl(${hue} 55% 32%)` };
}

/** Highlights matching words in search results. */
function highlightQuery(text: string, query: string) {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return text;
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = text.split(new RegExp(`(${escaped.join("|")})`, "gi"));
  // Split with a single capture group: odd indices are always matches.
  return parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part));
}

function useRoute(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

/* ---------- shared styles ---------- */

const label = "font-mono text-[10px] uppercase tracking-[0.12em] text-muted";
const card = "rounded-lg border border-line bg-panel shadow-[0_1px_3px_rgba(15,23,42,0.06)]";
const inputCls =
  "w-full rounded-lg border border-line bg-panel px-3.5 py-2.5 text-[14px] text-ink " +
  "placeholder:text-muted/70 focus:outline-2 focus:outline-navy focus:-outline-offset-1";
const navyBtn =
  "cursor-pointer rounded-lg bg-navy px-5 py-2.5 text-[13px] font-semibold text-white " +
  "hover:bg-navydark disabled:cursor-default disabled:opacity-50";

const ICONS: Record<string, string> = {
  jobs: "M4 5h16v3H4zM4 10h16v9H4zM2 5l2-3h3L5 5zM9 5l2-3h3l-2 3zM14 5l2-3h3l-2 3z",
  usage: "M4 20V10h3v10H4zm6.5 0V4h3v16h-3zM17 20v-7h3v7h-3z",
  keys: "M14 3a7 7 0 00-6.9 8.4L2 16.5V21h4.5l1-1v-2h2v-2h2l1.6-1.6A7 7 0 1014 3zm2.5 6a1.5 1.5 0 110-3 1.5 1.5 0 010 3z",
  clock: "M12 2a10 10 0 100 20 10 10 0 000-20zm1 10.4l4.2 2.5-.8 1.3L11 13V6h2v6.4z",
  globe: "M12 2a10 10 0 100 20 10 10 0 000-20zm7.9 9h-3.4a15.6 15.6 0 00-1.3-6.1A8 8 0 0119.9 11zM12 20c-.9 0-2.4-2.6-2.9-7h5.8c-.5 4.4-2 7-2.9 7zm-2.9-9c.5-4.4 2-7 2.9-7s2.4 2.6 2.9 7H9.1zM8.8 4.9A15.6 15.6 0 007.5 11H4.1a8 8 0 014.7-6.1zM4.1 13h3.4a15.6 15.6 0 001.3 6.1A8 8 0 014.1 13zm11.1 6.1a15.6 15.6 0 001.3-6.1h3.4a8 8 0 01-4.7 6.1z",
  scenes: "M4 4h16v16H4V4zm2 2v3h3V6H6zm5 0v3h3V6h-3zm5 0v3h3V6h-3zM6 11v3h3v-3H6zm5 0v3h3v-3h-3zm5 0v3h3v-3h-3zM6 16v3h3v-3H6zm5 0v3h3v-3h-3zm5 0v3h3v-3h-3z",
  mic: "M12 14a4 4 0 004-4V6a4 4 0 10-8 0v4a4 4 0 004 4zm6-4a6 6 0 01-12 0H4a8 8 0 007 7.9V21h2v-3.1A8 8 0 0020 10h-2z",
  trash: "M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-1 12H7L6 9z",
  retry: "M12 5V1L7 6l5 5V7a5 5 0 11-5 5H5a7 7 0 107-7z",
};

function Icon({ name, className = "h-4 w-4" }: { name: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICONS[name]} fill="currentColor" />
    </svg>
  );
}

function StatusChip({ job }: { job: Job }) {
  const pct = Math.round((job.progress ?? 0) * 100);
  const base =
    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em]";
  if (job.status === "done")
    return (
      <span className={`${base} bg-ok/10 text-ok`}>
        <i className="h-1.5 w-1.5 rounded-full bg-current" /> Done
      </span>
    );
  if (job.status === "failed")
    return (
      <span className={`${base} bg-err/10 text-err`}>
        <i className="h-1.5 w-1.5 rounded-full bg-current" /> Failed
      </span>
    );
  return (
    <span className={`${base} bg-amber/10 text-amber`}>
      <i className="pulse-dot h-1.5 w-1.5 rounded-full bg-current" />
      {job.status === "processing" ? `${job.stage ?? "processing"} ${pct}%` : "Queued"}
    </span>
  );
}

/* ---------- shell ---------- */

export default function App() {
  const route = useRoute();
  const [filter, setFilter] = useState("");
  const jobId = route.match(/^#\/jobs\/([0-9a-f]{16})/)?.[1];
  const page = jobId
    ? { title: "Job result", view: <JobDetail id={jobId} /> }
    : route.startsWith("#/usage")
      ? { title: "Usage", view: <UsageView /> }
      : route.startsWith("#/keys")
        ? { title: "API keys", view: <KeysView /> }
        : { title: "Jobs", view: <JobsView filter={filter} /> };

  return (
    <div className="flex min-h-screen bg-bg text-body max-[900px]:flex-col">
      <Sidebar route={route} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar crumb={page.title} filter={filter} onFilter={setFilter} />
        <main className="mx-auto w-full max-w-[1180px] flex-1 px-9 pb-16 pt-8 max-[900px]:px-5">
          {page.view}
        </main>
      </div>
    </div>
  );
}

function Sidebar({ route }: { route: string }) {
  const items = [
    { href: "#/", icon: "jobs", text: "Jobs", active: !route.startsWith("#/usage") && !route.startsWith("#/keys") },
    { href: "#/usage", icon: "usage", text: "Usage", active: route.startsWith("#/usage") },
    { href: "#/keys", icon: "keys", text: "API keys", active: route.startsWith("#/keys") },
  ];
  function newJob() {
    window.location.hash = "#/";
    setTimeout(() => document.getElementById("ingest-url")?.focus(), 60);
  }
  return (
    <aside className="flex w-[240px] shrink-0 flex-col border-r border-line bg-panel px-4 py-5 max-[900px]:w-auto max-[900px]:flex-row max-[900px]:items-center max-[900px]:gap-4 max-[900px]:border-b max-[900px]:border-r-0 max-[900px]:py-3">
      <a href="#/" className="flex items-center gap-2.5 px-2">
        <span className="stripe-dark h-7 w-7 shrink-0 rounded-lg" aria-hidden="true" />
        <span className="text-[15px] font-bold leading-tight text-ink" style={{ fontFamily: "var(--font-head)" }}>
          Klaket Console
          <span className="block font-mono text-[9px] font-normal uppercase tracking-[0.14em] text-muted max-[900px]:hidden">
            self-hosted
          </span>
        </span>
      </a>

      <button onClick={newJob} className={`${navyBtn} mt-6 w-full max-[900px]:order-last max-[900px]:ml-auto max-[900px]:mt-0 max-[900px]:w-auto`}>
        ＋ New job
      </button>

      <nav className="mt-6 flex flex-col gap-1 max-[900px]:mt-0 max-[900px]:flex-row">
        {items.map((it) => (
          <a
            key={it.href}
            href={it.href}
            className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13.5px] font-medium ${
              it.active ? "bg-navy/10 text-navy" : "text-muted hover:bg-panel2 hover:text-ink"
            }`}
          >
            <Icon name={it.icon} className="h-[16px] w-[16px] opacity-85" /> {it.text}
          </a>
        ))}
      </nav>

      <div className="mt-auto px-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted max-[900px]:hidden">
        Self-hosted · AGPL-3.0
      </div>
    </aside>
  );
}

function TopBar({ crumb, filter, onFilter }: { crumb: string; filter: string; onFilter: (v: string) => void }) {
  return (
    <header className="flex items-center justify-between gap-4 border-b border-line bg-panel px-9 py-3 max-[900px]:px-5">
      <div className="flex items-center gap-5">
        <div className="text-[13px] text-muted">
          Console <span className="mx-1 text-line2">/</span> <span className="font-medium text-ink">{crumb}</span>
        </div>
        <input
          value={filter}
          onChange={(e) => {
            onFilter(e.target.value);
            if (window.location.hash.startsWith("#/jobs/")) window.location.hash = "#/";
          }}
          placeholder="Search jobs, ID…"
          aria-label="Search jobs"
          className="w-[clamp(140px,20vw,260px)] rounded-full border border-line bg-bg px-4 py-1.5 text-[13px] placeholder:text-muted/70 focus:outline-2 focus:outline-navy focus:-outline-offset-1 max-[900px]:hidden"
        />
      </div>
      <div className="flex items-center gap-4">
        <a href="https://github.com/huseyinstif/klaket" target="_blank" rel="noreferrer" className="text-[13px] font-medium text-muted hover:text-ink max-[900px]:hidden">
          GitHub
        </a>
        <a
          href="https://github.com/huseyinstif/klaket"
          target="_blank"
          rel="noreferrer"
          className="rounded-lg border border-navy px-3.5 py-1.5 text-[12.5px] font-semibold text-navy hover:bg-navy hover:text-white"
        >
          Star on GitHub
        </a>
      </div>
    </header>
  );
}

/* ---------- Jobs ---------- */

const JOBS_PER_PAGE = 8;

function JobsView({ filter }: { filter: string }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => setPage(1), [filter]); // reset to the first page when the search changes

  const refresh = useCallback(() => {
    listJobs().then(setJobs).catch(() => setError("API unreachable — is `docker compose up` running?"));
    getUsage().then(setUsage).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const active = jobs.filter((j) => j.status === "processing" || j.status === "queued").length;
  const doneCount = jobs.filter((j) => j.status === "done").length;
  const totalMinutes = jobs.reduce((sum, j) => sum + (j.duration ?? 0), 0) / 60;
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? jobs.filter(
        (j) =>
          (j.title || "").toLowerCase().includes(needle) ||
          j.url.toLowerCase().includes(needle) ||
          j.id.startsWith(needle),
      )
    : jobs;
  const pageCount = Math.max(1, Math.ceil(visible.length / JOBS_PER_PAGE));
  const safePage = Math.min(page, pageCount);
  const paged = visible.slice((safePage - 1) * JOBS_PER_PAGE, safePage * JOBS_PER_PAGE);

  return (
    <>
      <header className="mb-7">
        <h1 className="text-[28px] font-bold tracking-tight">Jobs</h1>
        <p className="mt-1 text-[14.5px] text-muted">Manage and monitor your video-to-LLM ingestion tasks.</p>
      </header>

      <div className="mb-6 grid grid-cols-4 gap-4 max-[1120px]:grid-cols-2">
        <StatTile label="Minutes this month" value={usage ? usage.used_minutes.toFixed(1) : "…"} />
        <StatTile label="Jobs completed" value={String(doneCount)} />
        <StatTile label="Active now" value={String(active)} live={active > 0} />
        <StatTile label="Total minutes" value={totalMinutes.toFixed(1)} />
      </div>

      <IngestPanel rolling={active > 0} onQueued={refresh} />

      {error && <div className={`${card} mt-5 px-4 py-3 text-[13.5px] text-muted`}>{error}</div>}

      {jobs.length === 0 && !error ? (
        <div className="mt-8 rounded-lg border border-dashed border-line2 bg-panel p-12 text-center text-muted">
          <div className="stripe mx-auto mb-4 h-2 w-20 rounded opacity-60" aria-hidden="true" />
          No jobs yet. Paste a video URL above and press <strong className="text-ink">Ingest</strong>.
        </div>
      ) : (
        <section className={`${card} mt-8 overflow-hidden`}>
          <div className="flex items-baseline justify-between border-b border-line px-5 py-4">
            <h2 className="text-[16px] font-semibold">
              Recent jobs <span className="text-[13px] font-normal text-muted">({visible.length})</span>
              {needle && <span className="ml-2 font-mono text-[11px] font-normal text-muted">filtered</span>}
            </h2>
          </div>
          <JobsTable jobs={paged} onChanged={refresh} />
          <div className="flex items-center justify-between border-t border-line px-5 py-3.5">
            <span className="font-mono text-[11px] text-muted">
              {visible.length} jobs · page {safePage}/{pageCount}
            </span>
            {pageCount > 1 && <Pager page={safePage} pageCount={pageCount} onPage={setPage} />}
          </div>
        </section>
      )}
    </>
  );
}

function StatTile({ label: text, value, live }: { label: string; value: string; live?: boolean }) {
  return (
    <div className={`${card} px-5 py-4`}>
      <div className={label}>{text}</div>
      <div className="mt-1 flex items-center gap-2 text-[24px] font-bold tracking-tight text-ink" style={{ fontFamily: "var(--font-head)" }}>
        {value}
        {live && <span className="pulse-dot h-2 w-2 rounded-full bg-brand" aria-label="active" />}
      </div>
    </div>
  );
}

function IngestPanel({ rolling, onQueued }: { rolling: boolean; onQueued: () => void }) {
  const [url, setUrl] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await ingest(url.trim(), { model, prompt: prompt.trim() });
      setUrl("");
      onQueued();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ingest failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`${card} overflow-hidden`}>
      <div className={`stripe h-[3px] ${rolling ? "stripe-roll" : ""}`} aria-hidden="true" />
      <div className="px-5 pt-4 text-[15px] font-semibold text-ink">New ingest</div>
      <form className="flex items-end gap-4 px-5 pb-2 pt-3 max-[1120px]:flex-wrap" onSubmit={submit}>
        <div className="min-w-0 flex-1 max-[1120px]:basis-full">
          <label className={`${label} mb-1.5 block`} htmlFor="ingest-url">
            Video URL or file path
          </label>
          <input
            id="ingest-url"
            className={inputCls}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://youtube.com/watch?v=…"
            spellCheck={false}
          />
        </div>
        <div>
          <label className={`${label} mb-1.5 block`} htmlFor="ingest-model">
            Model
          </label>
          <select
            id="ingest-model"
            className="cursor-pointer rounded-lg border border-line bg-panel px-3 py-2.5 text-[13.5px] text-ink focus:outline-2 focus:outline-navy focus:-outline-offset-1"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            title="Transcription model"
          >
            <option value="">Small · default</option>
            <option value="tiny">Tiny · fastest</option>
            <option value="base">Base</option>
            <option value="medium">Medium · better</option>
            <option value="large-v3">Large-v3 · best</option>
          </select>
        </div>
        <button className={navyBtn} type="submit" disabled={busy || !url.trim()}>
          {busy ? "Queueing…" : "Ingest"}
        </button>
      </form>
      <button
        type="button"
        className="cursor-pointer px-5 pb-4 pt-1 text-[12.5px] font-medium text-navy hover:underline"
        onClick={() => setAdvanced(!advanced)}
      >
        {advanced ? "▾" : "▸"} Advanced: context prompt
      </button>
      {advanced && (
        <div className="px-5 pb-4">
          <input
            className={inputCls}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Names & jargon in the video, e.g. “Klaket, Polat Alemdar, RAG”"
            aria-label="Context prompt"
            maxLength={500}
          />
        </div>
      )}
      {error && <div className="px-5 pb-4 text-[13px] text-err">{error}</div>}
    </section>
  );
}

function JobsTable({ jobs, onChanged }: { jobs: Job[]; onChanged: () => void }) {
  async function remove(j: Job) {
    if (!window.confirm(`Delete job "${j.title || j.id}" and its artifacts?`)) return;
    await deleteJob(j.id).catch(() => {});
    onChanged();
  }
  async function retry(j: Job) {
    await ingest(j.url).catch(() => {});
    await deleteJob(j.id).catch(() => {});
    onChanged();
  }
  const th = `${label} px-5 py-3 text-left`;
  const td = "border-t border-line px-5 py-3 align-middle";
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] border-collapse">
        <thead>
          <tr className="bg-panel2">
            <th className={th}>Video</th>
            <th className={th}>Duration</th>
            <th className={th}>Status</th>
            <th className={th}>Created</th>
            <th className={`${th} text-right`}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id} className="hover:bg-panel2/60">
              <td className={td}>
                <div className="flex items-center gap-3">
                  <RowThumb job={j} />
                  <div className="min-w-0">
                    <div className="max-w-[340px] truncate text-[14px] font-medium text-ink" title={j.title || j.url}>
                      {j.title || j.url}
                    </div>
                    <div className="font-mono text-[11px] text-muted">job_{j.id.slice(0, 8)}</div>
                  </div>
                </div>
              </td>
              <td className={`${td} font-mono text-[12.5px] text-muted`}>{j.duration ? timecode(j.duration) : "—"}</td>
              <td className={td}>
                <StatusChip job={j} />
                {j.status === "processing" && (
                  <div className="mt-1.5 h-1 w-24 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={Math.round((j.progress ?? 0) * 100)}>
                    <div className="h-full rounded-full bg-amber transition-[width] duration-500" style={{ width: `${Math.round((j.progress ?? 0) * 100)}%` }} />
                  </div>
                )}
                {j.status === "failed" && (
                  <div className="mt-1 max-w-[200px] truncate font-mono text-[10.5px] text-err" title={j.error}>
                    {j.error}
                  </div>
                )}
              </td>
              <td className={`${td} font-mono text-[12px] text-muted`}>{new Date(j.created_at).toLocaleString()}</td>
              <td className={`${td} text-right`}>
                <div className="flex items-center justify-end gap-3">
                  {j.status === "done" && (
                    <a className="text-[13px] font-semibold text-navy hover:underline" href={`#/jobs/${j.id}`}>
                      View result
                    </a>
                  )}
                  {j.status === "failed" && (
                    <button
                      className="flex cursor-pointer items-center gap-1 text-[13px] font-medium text-muted hover:text-navy"
                      onClick={() => retry(j)}
                      title="Retry"
                    >
                      <Icon name="retry" className="h-3.5 w-3.5" /> Retry
                    </button>
                  )}
                  <button className="cursor-pointer text-muted hover:text-err" onClick={() => remove(j)} aria-label={`Delete job ${j.id}`} title="Delete job">
                    <Icon name="trash" className="h-4 w-4" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowThumb({ job }: { job: Job }) {
  const [broken, setBroken] = useState(false);
  if (job.status !== "done" || broken) {
    return (
      <div className="flex h-[40px] w-[72px] shrink-0 items-center justify-center rounded-md border border-line bg-panel2 text-[16px] opacity-60" aria-hidden="true">
        🎬
      </div>
    );
  }
  return (
    <img
      src={fileUrl(job.id, "scene_000.jpg")}
      alt=""
      loading="lazy"
      className="h-[40px] w-[72px] shrink-0 rounded-md border border-line object-cover"
      onError={() => setBroken(true)}
    />
  );
}

function Pager({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (n: number) => void }) {
  const btn =
    "min-w-[30px] h-[30px] cursor-pointer rounded-md border border-line bg-panel text-[12.5px] text-muted hover:border-navy hover:text-navy disabled:cursor-default disabled:opacity-35";
  return (
    <nav className="flex items-center gap-1.5" aria-label="Job pages">
      <button className={btn} disabled={page === 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
        ‹
      </button>
      {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          className={n === page ? "min-w-[30px] h-[30px] cursor-pointer rounded-md bg-navy text-[12.5px] font-semibold text-white" : btn}
          onClick={() => onPage(n)}
          aria-current={n === page ? "page" : undefined}
        >
          {n}
        </button>
      ))}
      <button className={btn} disabled={page === pageCount} onClick={() => onPage(page + 1)} aria-label="Next page">
        ›
      </button>
    </nav>
  );
}

/* ---------- Job detail ---------- */

function JobDetail({ id }: { id: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [result, setResult] = useState<JobResult | null>(null);
  const [time, setTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [tab, setTab] = useState<"transcript" | "chapters" | "scenes">("transcript");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Awaited<ReturnType<typeof searchJob>> | null>(null);

  const seek = (t: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = t;
    video.play().catch(() => {});
  };

  const activeIdx = result ? result.transcript.findIndex((s) => time >= s.start && time < s.end) : -1;

  useEffect(() => {
    document.querySelector(".seg-active")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIdx]);

  useEffect(() => {
    let timer: number | undefined;
    let stopped = false;
    async function poll() {
      try {
        const j = await getJob(id);
        if (stopped) return;
        setJob(j);
        if (j.status === "done") {
          setResult(await getResult(id));
          return;
        }
        if (j.status !== "failed") timer = window.setTimeout(poll, 2000);
      } catch {
        /* keep the last known state */
      }
    }
    poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [id]);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) {
      setHits(null);
      return;
    }
    setHits(await searchJob(id, query.trim()).catch(() => []));
  }

  if (!job) return <div className={`${card} px-4 py-3 text-[13.5px] text-muted`}>Loading…</div>;

  const speakers = result ? [...new Set(result.transcript.map((s) => s.speaker).filter(Boolean))] : [];
  const activeScene = result ? result.scenes.find((sc) => time >= sc.start && time < sc.end)?.index : undefined;

  return (
    <>
      <header className="mb-6">
        <a className="mb-2 inline-block text-[13px] font-medium text-muted hover:text-navy" href="#/">
          ← Jobs
        </a>
        <h1 className="text-[24px] font-bold leading-snug tracking-tight">{job.title || job.url}</h1>
        {result && (
          <div className="mt-3 flex flex-wrap gap-2">
            <MetaChip icon="clock">{timecode(result.duration)}</MetaChip>
            <MetaChip icon="globe">{result.language.toUpperCase()}</MetaChip>
            <MetaChip icon="scenes">{result.scenes.length} scenes</MetaChip>
            {speakers.length > 0 && <MetaChip icon="mic">{speakers.length} speakers</MetaChip>}
          </div>
        )}
        {job.status !== "done" && (
          <div className="mt-3">
            <StatusChip job={job} />
          </div>
        )}
        {job.status === "failed" && (
          <div className="mt-3 rounded-lg border border-err/25 bg-err/5 px-4 py-3 font-mono text-[13px] text-err">{job.error}</div>
        )}
      </header>

      {result && (
        <div className="grid grid-cols-[1.4fr_1fr] items-start gap-5 max-[1120px]:grid-cols-1">
          {/* left: player + film strip + search */}
          <section className={`${card} min-w-0 p-5`}>
            <video
              className={`w-full rounded-lg border border-line bg-black object-contain ${
                result.scenes.length > 0 ? "aspect-video" : "h-[56px]"
              }`}
              ref={videoRef}
              controls
              preload="metadata"
              poster={result.scenes[0] ? fileUrl(id, result.scenes[0].keyframe) : undefined}
              src={fileUrl(id, result.media_file ?? "source.mp4")}
              onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            />
            {result.scenes.length === 0 && <div className={`${label} mt-3`}>Audio-only — no scenes</div>}
            {result.scenes.length > 1 && (
              <FilmStrip id={id} scenes={result.scenes} activeScene={activeScene} seek={seek} />
            )}
            <form className="mt-4" onSubmit={runSearch}>
              <input
                className={inputCls}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a moment in this video…"
                aria-label="Search in video"
              />
            </form>
            {hits !== null && (
              <div className="mt-3 flex flex-col gap-2">
                {hits.length === 0 && <p className="font-mono text-[12px] text-muted">No moments found.</p>}
                {hits.map((h, i) => (
                  <button
                    key={i}
                    onClick={() => seek(h.start)}
                    className="flex cursor-pointer items-baseline gap-3.5 rounded-lg border border-line bg-panel2 px-4 py-2.5 text-left text-[13.5px] text-ink hover:border-navy"
                  >
                    <span className="w-[50px] shrink-0 font-mono text-[12px] font-semibold text-amber">{timecode(h.start)}</span>
                    <span className="truncate">{highlightQuery(h.text, query)}</span>
                    <span className="ml-auto text-[12px] text-navy">›</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* right: tabbed panel */}
          <section className={`${card} min-w-0 p-5`}>
            <div className="mb-4 flex gap-1 border-b border-line" role="tablist">
              {(["transcript", "chapters", "scenes"] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={`-mb-px cursor-pointer border-b-2 px-4 py-2.5 text-[13.5px] font-medium capitalize ${
                    tab === t ? "border-navy text-navy" : "border-transparent text-muted hover:text-ink"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            {tab === "transcript" && (
              <div className="flex max-h-[56vh] flex-col gap-1 overflow-y-auto pr-2">
                {result.transcript.length === 0 && <p className="text-muted">No speech detected.</p>}
                {result.transcript.map((seg, i) => (
                  <div
                    key={i}
                    onClick={() => seek(seg.start)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && seek(seg.start)}
                    title="Jump to this moment"
                    className={`flex cursor-pointer gap-4 rounded-md border-l-2 px-3 py-2 ${
                      i === activeIdx ? "seg-active border-navy bg-panel2" : "border-transparent hover:bg-panel2/70"
                    }`}
                  >
                    <span className={`w-[50px] shrink-0 pt-0.5 font-mono text-[12px] text-amber ${i === activeIdx ? "font-bold" : ""}`}>
                      {timecode(seg.start)}
                    </span>
                    <span className="flex min-w-0 flex-col gap-1">
                      {seg.speaker && (
                        <span
                          className="self-start rounded-md px-2 py-[2px] font-mono text-[9px] font-bold uppercase tracking-[0.06em]"
                          style={speakerStyle(seg.speaker)}
                        >
                          {seg.speaker.replace(/^S(\d+)$/, "Speaker $1")}
                        </span>
                      )}
                      <span className="text-[14px] leading-relaxed text-ink">{seg.text}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {tab === "chapters" && (
              <div className="flex max-h-[56vh] flex-col gap-1 overflow-y-auto pr-2">
                {result.chapters?.map((ch) => (
                  <button
                    key={ch.index}
                    onClick={() => seek(ch.start)}
                    className="flex cursor-pointer items-baseline gap-4 rounded-md px-3 py-2 text-left text-[13.5px] text-ink hover:bg-panel2"
                  >
                    <span className="w-[50px] shrink-0 font-mono text-[12px] text-amber">{timecode(ch.start)}</span>
                    <span className="truncate">{ch.title}</span>
                  </button>
                ))}
              </div>
            )}

            {tab === "scenes" && (
              <div className="grid max-h-[56vh] grid-cols-2 gap-4 overflow-y-auto pr-2">
                {result.scenes.map((sc) => (
                  <figure
                    key={sc.index}
                    onClick={() => seek(sc.start)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && seek(sc.start)}
                    title="Jump to this scene"
                    className="group m-0 cursor-pointer"
                  >
                    <img
                      src={fileUrl(id, sc.keyframe)}
                      alt={`Scene ${sc.index}`}
                      loading="lazy"
                      className="block w-full rounded-lg border border-line group-hover:border-navy"
                    />
                    <figcaption className="mt-1 font-mono text-[10px] text-muted">
                      {timecode(sc.start)} → {timecode(sc.end)}
                    </figcaption>
                    {sc.description && <p className="mt-1 text-[12px] text-ink">{sc.description}</p>}
                    {sc.ocr && <p className="mt-0.5 font-mono text-[11px] text-amber">“{sc.ocr}”</p>}
                  </figure>
                ))}
              </div>
            )}

            <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
              {[
                { href: `/api/v1/jobs/${id}/result`, text: "{ } JSON", blank: true },
                { href: fileUrl(id, "result.md"), text: "▤ MD", blank: true },
                { href: fileUrl(id, "subtitles.srt"), text: "⬇ SRT" },
                { href: fileUrl(id, "subtitles.vtt"), text: "⬇ VTT" },
              ].map((d) => (
                <a
                  key={d.text}
                  href={d.href}
                  {...(d.blank ? { target: "_blank", rel: "noreferrer" } : { download: true })}
                  className="rounded-full border border-line px-3.5 py-1.5 font-mono text-[11px] text-navy hover:border-navy hover:bg-navy/5"
                >
                  {d.text}
                </a>
              ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function FilmStrip({
  id, scenes, activeScene, seek,
}: {
  id: string;
  scenes: JobResult["scenes"];
  activeScene: number | undefined;
  seek: (t: number) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(true);

  const updateArrows = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 8);
    setCanRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 8);
  }, []);

  // Keep the active frame visible during playback.
  useEffect(() => {
    stripRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [activeScene]);

  useEffect(() => {
    updateArrows();
  }, [updateArrows, scenes.length]);

  const nudge = (dir: number) => {
    const el = stripRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };

  const arrowCls =
    "flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-line bg-panel " +
    "text-[14px] text-muted hover:border-navy hover:text-navy disabled:opacity-30 disabled:cursor-default";

  return (
    <>
      <div className={`${label} mt-4 flex items-center justify-between`}>
        <span>Scenes · {scenes.length}</span>
        <span className="flex gap-1.5">
          <button className={arrowCls} onClick={() => nudge(-1)} disabled={!canLeft} aria-label="Previous scenes">
            ‹
          </button>
          <button className={arrowCls} onClick={() => nudge(1)} disabled={!canRight} aria-label="Next scenes">
            ›
          </button>
        </span>
      </div>
      <div className="relative mt-2">
        {canLeft && (
          <div className="pointer-events-none absolute inset-y-0 left-0 z-[5] w-10 bg-gradient-to-r from-panel to-transparent" aria-hidden="true" />
        )}
        {canRight && (
          <div className="pointer-events-none absolute inset-y-0 right-0 z-[5] w-10 bg-gradient-to-l from-panel to-transparent" aria-hidden="true" />
        )}
        <div ref={stripRef} onScroll={updateArrows} className="flex gap-2 overflow-x-auto pb-2" role="list" aria-label="Scenes">
          {scenes.map((sc) => (
            <button
              key={sc.index}
              data-active={sc.index === activeScene}
              onClick={() => seek(sc.start)}
              title={`${timecode(sc.start)} → ${timecode(sc.end)}`}
              className={`relative shrink-0 cursor-pointer overflow-hidden rounded-lg border-2 p-0 ${
                sc.index === activeScene ? "border-navy" : "border-transparent"
              }`}
            >
              <img
                src={fileUrl(id, sc.keyframe)}
                alt=""
                loading="lazy"
                className={`block h-[62px] w-[110px] rounded-md border border-line object-cover transition-opacity ${
                  sc.index === activeScene ? "" : "opacity-75 hover:opacity-100"
                }`}
              />
              <span
                className={`absolute bottom-1 left-1 rounded bg-white/90 px-1.5 font-mono text-[9px] ${
                  sc.index === activeScene ? "font-bold text-amber" : "text-muted"
                }`}
              >
                {timecode(sc.start)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function MetaChip({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3.5 py-1.5 font-mono text-[11px] text-ink shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
      <Icon name={icon} className="h-[13px] w-[13px] shrink-0 text-muted" />
      {children}
    </span>
  );
}

/* ---------- Usage ---------- */

function UsageView() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    getUsage().then(setUsage).catch(() => setError("API unreachable"));
    listJobs().then(setJobs).catch(() => {});
  }, []);

  const byStatus = (status: Job["status"]) => jobs.filter((j) => j.status === status).length;
  const totalMinutes = jobs.reduce((sum, j) => sum + (j.duration ?? 0), 0) / 60;

  return (
    <>
      <header className="mb-7">
        <h1 className="text-[28px] font-bold tracking-tight">Usage</h1>
        <p className="mt-1 text-[14.5px] text-muted">Video-minutes processed {usage ? `in ${usage.month}` : ""}.</p>
      </header>
      {error && <div className={`${card} px-4 py-3 text-[13.5px] text-muted`}>{error}</div>}
      {usage && (
        <div className="grid grid-cols-4 gap-4 max-[1120px]:grid-cols-2">
          <BigStat value={usage.used_minutes.toFixed(1)} caption="video-minutes this month" />
          <BigStat value={usage.quota_minutes > 0 ? usage.quota_minutes.toFixed(0) : "∞"} caption="monthly quota" />
          <BigStat value={String(jobs.length)} caption={`jobs · ${byStatus("done")} done / ${byStatus("failed")} failed`} />
          <BigStat value={totalMinutes.toFixed(1)} caption="total minutes, all time" />
        </div>
      )}
    </>
  );
}

function BigStat({ value, caption }: { value: string; caption: string }) {
  return (
    <div className={`${card} px-6 py-5`}>
      <div className="text-[30px] font-bold tracking-tight text-navy" style={{ fontFamily: "var(--font-head)" }}>
        {value}
      </div>
      <div className={`${label} mt-1`}>{caption}</div>
    </div>
  );
}

/* ---------- API keys ---------- */

function KeysView() {
  const [adminToken, setAdminToken] = useState(() => localStorage.getItem("klaket_admin_token") ?? "");
  const [keys, setKeys] = useState<AdminKey[]>([]);
  const [created, setCreated] = useState<AdminKey | null>(null);
  const [name, setName] = useState("");
  const [quota, setQuota] = useState("0");
  const [error, setError] = useState("");

  const refresh = useCallback((token: string) => {
    if (!token) return;
    adminListKeys(token)
      .then((k) => {
        setKeys(k);
        setError("");
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    refresh(adminToken);
  }, [adminToken, refresh]);

  function saveToken(value: string) {
    setAdminToken(value);
    localStorage.setItem("klaket_admin_token", value);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const key = await adminCreateKey(adminToken, name.trim(), parseFloat(quota) || 0);
      setCreated(key);
      setName("");
      refresh(adminToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    }
  }

  const th = `${label} border-b border-line px-4 pb-2.5 text-left`;
  const td = "border-b border-line px-4 py-3";

  return (
    <>
      <header className="mb-7">
        <h1 className="text-[28px] font-bold tracking-tight">API keys</h1>
        <p className="mt-1 text-[14.5px] text-muted">
          Requires the admin token (set <code className="font-mono text-[13px] text-ink">KLAKET_ADMIN_TOKEN</code> on the API service).
        </p>
      </header>

      <div className={`${card} mb-5 p-5`}>
        <div className={`${label} mb-2`}>Admin token</div>
        <input
          className={inputCls}
          type="password"
          value={adminToken}
          onChange={(e) => saveToken(e.target.value)}
          placeholder="Paste your KLAKET_ADMIN_TOKEN…"
          aria-label="Admin token"
        />
      </div>

      {error && <div className={`${card} mb-5 px-4 py-3 text-[13.5px] text-muted`}>{error}</div>}

      {adminToken && !error && (
        <>
          <div className={`${card} mb-5 p-5`}>
            <div className={`${label} mb-2`}>Create key</div>
            <form className="flex flex-wrap gap-3" onSubmit={create}>
              <input
                className={`${inputCls} min-w-[200px] flex-1`}
                value={name}
                required
                onChange={(e) => setName(e.target.value)}
                placeholder="Key name (e.g. acme-prod)"
                aria-label="Key name"
              />
              <input
                className={`${inputCls} max-w-[230px]`}
                value={quota}
                type="number"
                min="0"
                step="1"
                onChange={(e) => setQuota(e.target.value)}
                placeholder="Quota (min/month, 0 = unlimited)"
                aria-label="Monthly quota"
              />
              <button className={navyBtn} type="submit" disabled={!name.trim()}>
                Create
              </button>
            </form>
            {created && (
              <div className="mt-4 rounded-lg border border-navy/25 bg-navy/5 px-4 py-3 text-[13px] text-ink">
                New key (copy it now — shown only once): <strong className="font-mono">{created.token}</strong>
              </div>
            )}
          </div>

          <div className={`${card} overflow-x-auto p-5`}>
            <table className="w-full border-collapse text-left">
              <thead>
                <tr>
                  {["Name", "Token", "Used / quota (min)", "Created"].map((h) => (
                    <th key={h} className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.token ?? k.name}>
                    <td className={`${td} text-[14px] text-ink`}>{k.name}</td>
                    <td className={`${td} font-mono text-[12px] text-muted`}>{k.token}</td>
                    <td className={`${td} font-mono text-[12px] text-muted`}>
                      {k.used_minutes.toFixed(1)} / {k.quota_minutes > 0 ? k.quota_minutes : "∞"}
                    </td>
                    <td className={`${td} font-mono text-[12px] text-muted`}>
                      {k.created_at && new Date(k.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
