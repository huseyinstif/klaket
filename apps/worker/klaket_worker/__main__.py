"""Worker entry point: pops jobs from the Redis queue and runs the pipeline."""

import logging
import os
import pathlib
import shutil
import time
import traceback

import redis

from . import jobstore, notify, pipeline, playlist

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("klaket.worker")


def main() -> None:
    rdb = jobstore.connect()
    data_dir = os.environ.get("DATA_DIR", "./data")
    log.info("klaket-worker started (data=%s)", data_dir)

    while True:
        # Resilience: a Redis hiccup must not kill the worker — wait and retry.
        try:
            popped = rdb.brpop([jobstore.QUEUE_KEY, jobstore.CLEANUP_KEY], timeout=5)
        except redis.exceptions.RedisError as exc:
            log.warning("redis unreachable (%s); retrying in 3s", exc)
            time.sleep(3)
            continue
        if popped is None:
            continue
        queue, job_id = popped
        if queue == jobstore.CLEANUP_KEY:
            # The API deleted the job; the worker owns the artifact files.
            shutil.rmtree(pathlib.Path(data_dir) / "jobs" / job_id, ignore_errors=True)
            log.info("job %s: artifacts cleaned up", job_id)
            continue
        job = jobstore.get(rdb, job_id)
        if not job:
            log.warning("job %s not found in store, skipping", job_id)
            continue

        # Playlist: don't process the video — expand into child jobs, drop the placeholder.
        if playlist.is_playlist(job.get("url", "")):
            jobstore.update(rdb, job_id, status="processing", stage="expanding playlist", progress=0.1)
            try:
                entries = playlist.expand(job["url"])
                inherited = {k: job[k] for k in playlist.INHERITED_FIELDS if job.get(k)}
                for entry in entries:
                    jobstore.enqueue(rdb, {"url": entry["url"], **inherited})
                jobstore.delete_job(rdb, job_id)
                log.info("playlist %s: %d videos queued", job_id, len(entries))
            except Exception as exc:
                jobstore.update(rdb, job_id, status="failed", error=f"playlist expansion failed: {exc}")
                log.error("playlist %s: %s", job_id, exc)
            continue

        log.info("job %s: starting (%s)", job_id, job.get("url", ""))
        jobstore.update(rdb, job_id, status="processing", stage="ingest", progress=0.0)

        def on_progress(stage: str, progress: float, job_id=job_id) -> None:
            log.info("job %s: stage=%s progress=%.0f%%", job_id, stage, progress * 100)
            jobstore.update(rdb, job_id, stage=stage, progress=progress)

        try:
            meta = pipeline.run(
                job_id=job_id,
                url=job["url"],
                language=job.get("language", "auto"),
                data_dir=data_dir,
                on_progress=on_progress,
                model=job.get("model", ""),
                prompt=job.get("prompt", ""),
                num_speakers=int(job.get("num_speakers") or 0),
                translate_to=job.get("translate_to", ""),
            )
            jobstore.update(
                rdb, job_id,
                status="done", stage="done", progress=1.0,
                title=meta.get("title", ""), duration=meta.get("duration", 0.0),
            )
            jobstore.record_usage(
                rdb, job.get("api_key", ""), float(meta.get("duration", 0.0)) / 60.0
            )
            log.info("job %s: done", job_id)
        except pipeline.StageError as exc:
            jobstore.update(rdb, job_id, status="failed", error=str(exc))
            log.error("job %s: failed: %s", job_id, exc)
        except Exception as exc:  # keep the worker alive on unexpected errors
            log.error("job %s: crashed:\n%s", job_id, traceback.format_exc())
            try:
                jobstore.update(rdb, job_id, status="failed", error=f"internal error: {exc}")
            except redis.exceptions.RedisError:
                log.warning("job %s: failed state could not be written (redis down)", job_id)

        if job.get("webhook_url"):
            final = jobstore.get(rdb, job_id)
            notify.send(job["webhook_url"], {
                "id": job_id,
                "status": final.get("status", ""),
                "title": final.get("title", ""),
                "duration": float(final.get("duration") or 0),
                "error": final.get("error", ""),
            })


if __name__ == "__main__":
    main()
