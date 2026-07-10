"""LangChain document loader for Klaket.

    pip install klaket langchain-core

    from klaket.langchain import KlaketLoader

    docs = KlaketLoader("https://youtube.com/watch?v=…").load()
    # or from a finished job: KlaketLoader("1f3a9c04d2e88b17").load()

Each Document corresponds to a chapter (by="chapter", the default) or a
single transcript segment (by="segment"); metadata carries the video title,
time range, language, and speaker.
"""

import re
from typing import Iterator

from . import Klaket

_JOB_ID = re.compile(r"^[0-9a-f]{16}$")


class KlaketLoader:
    def __init__(
        self,
        source: str,
        *,
        base_url: str = "http://localhost:8484",
        api_key: str = "",
        by: str = "chapter",
        **ingest_options,
    ):
        if by not in ("chapter", "segment"):
            raise ValueError('by must be "chapter" or "segment"')
        self.source = source
        self.by = by
        self.ingest_options = ingest_options
        self.client = Klaket(base_url, api_key)

    def _result(self) -> dict:
        if _JOB_ID.match(self.source):
            return self.client.result(self.source)
        return self.client.process(self.source, **self.ingest_options)

    def lazy_load(self) -> Iterator:
        try:
            from langchain_core.documents import Document
        except ImportError as exc:  # pragma: no cover
            raise ImportError("KlaketLoader requires langchain-core: pip install langchain-core") from exc

        result = self._result()
        base_meta = {
            "source": result.get("url", self.source),
            "title": result.get("title", ""),
            "language": result.get("language", ""),
            "klaket_job_id": result.get("id", ""),
        }
        if self.by == "segment":
            for seg in result["transcript"]:
                yield Document(
                    page_content=seg["text"],
                    metadata={**base_meta, "start": seg["start"], "end": seg["end"],
                              "speaker": seg.get("speaker", "")},
                )
            return
        for chapter in result.get("chapters", []):
            texts = [
                seg["text"] for seg in result["transcript"]
                if seg["start"] < chapter["end"] and seg["end"] > chapter["start"]
            ]
            yield Document(
                page_content=" ".join(texts) or chapter["title"],
                metadata={**base_meta, "chapter": chapter["title"],
                          "start": chapter["start"], "end": chapter["end"]},
            )

    def load(self) -> list:
        return list(self.lazy_load())
