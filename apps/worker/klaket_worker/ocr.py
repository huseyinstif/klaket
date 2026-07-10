"""Optional on-screen text extraction. Local ONNX models, zero API keys.

Controlled by KLAKET_OCR (default "on"). The engine is lazy-loaded once per
worker process; the first call downloads small detection/recognition models.
"""

import logging
import os

log = logging.getLogger("klaket.ocr")

_engine = None


def enabled() -> bool:
    return os.environ.get("KLAKET_OCR", "on").lower() not in ("off", "0", "false")


def _custom_model_kwargs() -> dict:
    """Optional recognition-model override for non-English/Chinese scripts.

    Point KLAKET_OCR_REC_URL / KLAKET_OCR_DICT_URL at any PaddleOCR-compatible
    ONNX recognition model + key dictionary (e.g. the "latin" family covers 32
    languages including Turkish). Files download once into the models volume.
    """
    import pathlib
    import urllib.request

    rec_url = os.environ.get("KLAKET_OCR_REC_URL", "")
    dict_url = os.environ.get("KLAKET_OCR_DICT_URL", "")
    if not (rec_url and dict_url):
        return {}
    models = pathlib.Path(os.environ.get("KLAKET_MODEL_DIR", "/models")) / "ocr"
    models.mkdir(parents=True, exist_ok=True)
    rec_path, dict_path = models / "rec.onnx", models / "dict.txt"
    if not rec_path.exists():
        log.info("downloading custom OCR recognition model (one-time)…")
        urllib.request.urlretrieve(rec_url, rec_path)
        urllib.request.urlretrieve(dict_url, dict_path)
    return {"rec_model_path": str(rec_path), "rec_keys_path": str(dict_path)}


def read_text(image_path) -> str:
    """Return the text visible in the image, left-to-right, or ""."""
    global _engine
    try:
        if _engine is None:
            from rapidocr_onnxruntime import RapidOCR

            _engine = RapidOCR(**_custom_model_kwargs())
        result, _elapsed = _engine(str(image_path))
        if not result:
            return ""
        # Low-confidence reads are noise (textures/patterns mistaken for letters).
        pieces = [
            item[1] for item in result
            if (len(item) < 3 or float(item[2]) >= 0.5) and _meaningful(item[1])
        ]
        text = " ".join(pieces).strip()
        # Fewer than 3 meaningful characters total = pattern noise ('C', '米 米', etc.)
        return text if sum(ch.isalnum() for ch in text) >= 3 else ""
    except Exception as exc:  # OCR must never fail the whole job
        log.warning("ocr failed for %s: %s", image_path, exc)
        return ""


def _meaningful(text: str) -> bool:
    """Drop single letter/symbol crumbs; keep real words."""
    return sum(ch.isalnum() for ch in text) >= 2
