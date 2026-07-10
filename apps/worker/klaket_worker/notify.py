"""Webhook delivery: POST the final job state to the caller's endpoint.

Best-effort by design — a dead webhook must never fail or retry-block a job.
"""

import json
import logging
import urllib.request

log = logging.getLogger("klaket.notify")

TIMEOUT_SECONDS = 10


def send(webhook_url: str, payload: dict) -> None:
    if not webhook_url:
        return
    req = urllib.request.Request(
        webhook_url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "klaket-webhook/0.4"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as res:
            log.info("webhook %s -> %s", webhook_url, res.status)
    except Exception as exc:
        log.warning("webhook %s failed: %s", webhook_url, exc)
