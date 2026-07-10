"""Pluggable vision-model layer for scene descriptions. STRICTLY OPTIONAL.

Klaket's core principle: the pipeline works with zero model APIs. This module
only activates when the operator opts in via KLAKET_VLM:

  KLAKET_VLM=off      (default) no scene descriptions
  KLAKET_VLM=ollama   local Ollama (base url defaults to host's :11434)
  KLAKET_VLM=openai   any OpenAI-compatible endpoint (BYOK)

  KLAKET_VLM_BASE_URL  override endpoint (e.g. https://api.openai.com/v1)
  KLAKET_VLM_MODEL     model name (e.g. qwen2.5vl, gpt-4.1-mini)
  KLAKET_VLM_API_KEY   bearer token if the endpoint needs one

Failures are non-fatal: a scene without a description is better than a failed job.
"""

import base64
import json
import logging
import os
import urllib.request

log = logging.getLogger("klaket.vlm")

_DEFAULTS = {
    "ollama": ("http://host.docker.internal:11434/v1", "qwen2.5vl"),
    "openai": ("https://api.openai.com/v1", "gpt-4.1-mini"),
}

PROMPT = (
    "Describe this video frame in one dense sentence for a search index: "
    "subjects, actions, setting, any on-screen UI or text context."
)


def mode() -> str:
    return os.environ.get("KLAKET_VLM", "off").lower()


def enabled() -> bool:
    return mode() in _DEFAULTS


def describe(image_path, language: str = "en") -> str:
    """Return a one-sentence description of the frame in the video's language, or ""."""
    base_default, model_default = _DEFAULTS[mode()]
    base = os.environ.get("KLAKET_VLM_BASE_URL", base_default).rstrip("/")
    model = os.environ.get("KLAKET_VLM_MODEL", model_default)
    api_key = os.environ.get("KLAKET_VLM_API_KEY", "")

    with open(image_path, "rb") as fh:
        b64 = base64.b64encode(fh.read()).decode()

    prompt = PROMPT
    if language and language != "en":
        # Keep descriptions in the same language as the video's transcript.
        prompt += f" Respond in the language with ISO 639-1 code '{language}'."

    payload = {
        "model": model,
        "max_tokens": 120,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
            ],
        }],
    }
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    if api_key:
        req.add_header("Authorization", f"Bearer {api_key}")

    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            body = json.load(res)
        return (body["choices"][0]["message"]["content"] or "").strip()
    except Exception as exc:
        log.warning("vlm describe failed for %s: %s", image_path, exc)
        return ""
