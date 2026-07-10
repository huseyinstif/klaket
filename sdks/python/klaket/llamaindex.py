"""LlamaIndex reader for Klaket.

    pip install klaket llama-index-core

    from klaket.llamaindex import KlaketReader

    docs = KlaketReader().load_data("https://youtube.com/watch?v=…")
"""

import re

from . import Klaket

_JOB_ID = re.compile(r"^[0-9a-f]{16}$")


class KlaketReader:
    def __init__(self, base_url: str = "http://localhost:8484", api_key: str = "", by: str = "chapter"):
        if by not in ("chapter", "segment"):
            raise ValueError('by must be "chapter" or "segment"')
        self.by = by
        self.client = Klaket(base_url, api_key)

    def load_data(self, source: str, **ingest_options) -> list:
        try:
            from llama_index.core.schema import Document
        except ImportError as exc:  # pragma: no cover
            raise ImportError("KlaketReader requires llama-index-core: pip install llama-index-core") from exc

        result = (
            self.client.result(source)
            if _JOB_ID.match(source)
            else self.client.process(source, **ingest_options)
        )
        base_meta = {
            "source": result.get("url", source),
            "title": result.get("title", ""),
            "language": result.get("language", ""),
            "klaket_job_id": result.get("id", ""),
        }
        docs = []
        if self.by == "segment":
            for seg in result["transcript"]:
                docs.append(Document(
                    text=seg["text"],
                    metadata={**base_meta, "start": seg["start"], "end": seg["end"],
                              "speaker": seg.get("speaker", "")},
                ))
            return docs
        for chapter in result.get("chapters", []):
            texts = [
                seg["text"] for seg in result["transcript"]
                if seg["start"] < chapter["end"] and seg["end"] > chapter["start"]
            ]
            docs.append(Document(
                text=" ".join(texts) or chapter["title"],
                metadata={**base_meta, "chapter": chapter["title"],
                          "start": chapter["start"], "end": chapter["end"]},
            ))
        return docs
