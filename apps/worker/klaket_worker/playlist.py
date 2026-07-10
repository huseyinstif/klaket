"""Playlist expansion: one URL → child jobs.

When a URL containing "list=" arrives, the worker does not download the video;
it expands the list with `yt-dlp --flat-playlist` (no video downloads, done in
seconds) and enqueues each entry as an independent job inheriting the parent
job's options (model/prompt/language/webhook…). KLAKET_PLAYLIST_LIMIT caps it.
"""

import json
import logging
import os
import subprocess

log = logging.getLogger("klaket.playlist")

DEFAULT_LIMIT = 25
HARD_LIMIT = 100


def limit() -> int:
    return min(int(os.environ.get("KLAKET_PLAYLIST_LIMIT", DEFAULT_LIMIT)), HARD_LIMIT)


def is_playlist(url: str) -> bool:
    return "list=" in url or "/playlist" in url


def expand(url: str, max_entries: int | None = None) -> list[dict]:
    """Expand the list into videos: [{"url", "title"}]. Downloads no video."""
    max_entries = max_entries or limit()
    proc = subprocess.run(
        ["yt-dlp", "--flat-playlist", "-J", "--no-warnings", url],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        tail = "\n".join((proc.stderr or "").strip().splitlines()[-3:])
        raise RuntimeError(f"playlist could not be read: {tail}")
    data = json.loads(proc.stdout)
    entries = data.get("entries") or []
    out = []
    for entry in entries[:max_entries]:
        video = entry.get("url") or entry.get("id")
        if not video:
            continue
        if not video.startswith("http"):
            video = f"https://www.youtube.com/watch?v={video}"
        out.append({"url": video, "title": entry.get("title", "")})
    if len(entries) > max_entries:
        log.info("playlist truncated: %d/%d videos queued (KLAKET_PLAYLIST_LIMIT)",
                 max_entries, len(entries))
    return out


# Job fields passed down to child jobs.
INHERITED_FIELDS = ("language", "model", "prompt", "num_speakers", "webhook_url", "api_key", "translate_to")
