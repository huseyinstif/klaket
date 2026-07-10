"""Redis-backed job state shared with the Go API."""

import datetime
import os
import secrets

import redis

QUEUE_KEY = "klaket:queue"
CLEANUP_KEY = "klaket:cleanup"
JOBS_SET_KEY = "klaket:jobs"
JOB_KEY_PREFIX = "klaket:job:"


def connect() -> redis.Redis:
    addr = os.environ.get("REDIS_ADDR", "localhost:6379")
    host, _, port = addr.partition(":")
    return redis.Redis(
        host=host,
        port=int(port or 6379),
        decode_responses=True,
        socket_keepalive=True,
        health_check_interval=30,
    )


def update(rdb: redis.Redis, job_id: str, **fields) -> None:
    fields["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat(
        timespec="seconds"
    )
    rdb.hset(JOB_KEY_PREFIX + job_id, mapping=fields)


def get(rdb: redis.Redis, job_id: str) -> dict:
    return rdb.hgetall(JOB_KEY_PREFIX + job_id)


def enqueue(rdb: redis.Redis, fields: dict) -> str:
    """Enqueue a new job (same schema as the Go API's enqueueJob)."""
    job_id = secrets.token_hex(8)  # matches the Go side: 16 hex characters
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    record = {"id": job_id, "status": "queued", "created_at": now, **fields}
    pipe = rdb.pipeline()
    pipe.hset(JOB_KEY_PREFIX + job_id, mapping=record)
    pipe.sadd(JOBS_SET_KEY, job_id)
    pipe.lpush(QUEUE_KEY, job_id)
    pipe.execute()
    return job_id


def delete_job(rdb: redis.Redis, job_id: str) -> None:
    """Remove the job record from the index + hash (artifacts are cleaned up separately)."""
    pipe = rdb.pipeline()
    pipe.srem(JOBS_SET_KEY, job_id)
    pipe.delete(JOB_KEY_PREFIX + job_id)
    pipe.execute()


def record_usage(rdb: redis.Redis, api_key: str, minutes: float) -> None:
    """Add processed video-minutes to the key's monthly usage counter."""
    month = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m")
    rdb.incrbyfloat(f"klaket:usage:{api_key or 'self-host'}:{month}", round(minutes, 3))
