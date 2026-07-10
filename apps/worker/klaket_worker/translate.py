"""Transcript translation — local and keyless via Argos Translate.

When `translate_to` is requested, transcript segments get a `translated` field
and translated subtitles (subtitles.<lang>.srt/vtt) are produced. Translation
models download on first use from the Argos package index into /models
(XDG_DATA_HOME).

Fail-soft: a translation error never fails the job — the original transcript
is always kept.
"""

import logging

log = logging.getLogger("klaket.translate")

_installed: set[tuple[str, str]] = set()


def _ensure_package(src: str, dst: str) -> None:
    import argostranslate.package as pkg

    key = (src, dst)
    if key in _installed:
        return
    installed = {(p.from_code, p.to_code) for p in pkg.get_installed_packages()}
    if key not in installed:
        log.info("downloading translation package %s→%s (one-time)…", src, dst)
        pkg.update_package_index()
        match = next(
            (p for p in pkg.get_available_packages() if p.from_code == src and p.to_code == dst),
            None,
        )
        if match is None:
            raise RuntimeError(f"no translation package for {src}→{dst}")
        pkg.install_from_path(match.download())
    _installed.add(key)


def translate_texts(texts: list[str], src: str, dst: str) -> list[str]:
    """Translate a list of texts src→dst (order preserved)."""
    import argostranslate.translate as tr

    _ensure_package(src, dst)
    return [tr.translate(text, src, dst) for text in texts]
