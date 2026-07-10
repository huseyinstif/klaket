"""Klaket Python SDK — turn any video into LLM-ready data.

Zero dependencies (stdlib urllib only).

    from klaket import Klaket

    k = Klaket()                                  # self-hosted on localhost:8484
    result = k.process("https://youtube.com/watch?v=...")
    for seg in result["transcript"]:
        print(seg["start"], seg.get("speaker", ""), seg["text"])
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request

__version__ = "0.7.0"


class KlaketError(RuntimeError):
    """API-level error (validation, quota, auth, failed job…)."""


class Klaket:
    def __init__(self, base_url: str = "http://localhost:8484", api_key: str = ""):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    # --- core calls ---

    def ingest(
        self,
        url: str,
        *,
        language: str = "auto",
        model: str = "",
        prompt: str = "",
        num_speakers: int = 0,
        webhook_url: str = "",
    ) -> str:
        """Queue a video; returns the job id."""
        body = {"url": url, "language": language}
        if model:
            body["model"] = model
        if prompt:
            body["prompt"] = prompt
        if num_speakers:
            body["num_speakers"] = num_speakers
        if webhook_url:
            body["webhook_url"] = webhook_url
        return self._request("POST", "/v1/ingest", body)["id"]

    def batch(self, urls: list, **options) -> list:
        """Queue many videos; returns the job ids."""
        body = {"urls": urls, **{k: v for k, v in options.items() if v}}
        return self._request("POST", "/v1/batch", body)["ids"]

    def status(self, job_id: str) -> dict:
        return self._request("GET", f"/v1/jobs/{job_id}")

    def result(self, job_id: str) -> dict:
        """The full LLM-ready result (transcript, scenes, chapters…)."""
        return self._request("GET", f"/v1/jobs/{job_id}/result")

    def search(self, job_id: str, query: str) -> list:
        """Find moments inside a processed video."""
        q = urllib.parse.quote(query)
        return self._request("GET", f"/v1/jobs/{job_id}/search?q={q}")["hits"]

    def delete(self, job_id: str) -> None:
        self._request("DELETE", f"/v1/jobs/{job_id}")

    def usage(self) -> dict:
        return self._request("GET", "/v1/usage")

    # --- conveniences ---

    def wait(self, job_id: str, *, timeout: float = 1800, poll: float = 3) -> dict:
        """Block until the job finishes; raises KlaketError on failure/timeout."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            job = self.status(job_id)
            if job["status"] == "done":
                return job
            if job["status"] == "failed":
                raise KlaketError(f"job {job_id} failed: {job.get('error', '')}")
            time.sleep(poll)
        raise KlaketError(f"job {job_id} timed out after {timeout}s")

    def process(self, url: str, **options) -> dict:
        """ingest + wait + result in one call."""
        job_id = self.ingest(url, **options)
        self.wait(job_id)
        return self.result(job_id)

    # --- plumbing ---

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        req = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={
                "Content-Type": "application/json",
                "User-Agent": f"klaket-python/{__version__}",
                **({"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}),
            },
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                raw = res.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            try:
                message = json.loads(exc.read()).get("error", str(exc))
            except Exception:
                message = str(exc)
            raise KlaketError(message) from None
