"""Speaker diarization — local, keyless (sherpa-onnx).

Answers "who spoke when" without any external API: a pyannote segmentation
model plus a speaker-embedding model, both downloaded once from public GitHub
releases into the models volume. Controlled by KLAKET_DIARIZE (default "on").

Fail-soft: any download/runtime error just leaves the transcript speakerless.
"""

import logging
import os
import pathlib
import tarfile
import urllib.request
import wave

log = logging.getLogger("klaket.diarize")

_SEGMENTATION_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
)
# Yes, "recongition" — the typo is in the upstream release tag itself.
_EMBEDDING_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
)

_diarizers: dict = {}


def enabled() -> bool:
    return os.environ.get("KLAKET_DIARIZE", "on").lower() not in ("off", "0", "false")


def _models_dir() -> pathlib.Path:
    return pathlib.Path(os.environ.get("KLAKET_MODEL_DIR", "/models")) / "diarization"


def _ensure_models() -> tuple[pathlib.Path, pathlib.Path]:
    models = _models_dir()
    models.mkdir(parents=True, exist_ok=True)

    segmentation = models / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
    if not segmentation.exists():
        archive = models / "segmentation.tar.bz2"
        log.info("downloading segmentation model (one-time)…")
        urllib.request.urlretrieve(_SEGMENTATION_URL, archive)
        with tarfile.open(archive, "r:bz2") as tar:
            tar.extractall(models, filter="data")
        archive.unlink(missing_ok=True)

    embedding = models / "speaker-embedding.onnx"
    if not embedding.exists():
        log.info("downloading speaker embedding model (one-time)…")
        urllib.request.urlretrieve(_EMBEDDING_URL, embedding)

    return segmentation, embedding


def _get_diarizer(num_speakers: int = 0):
    # A higher threshold merges clusters -> fewer speakers. On real content
    # (music/effects) 0.7 over-split; the 0.8 default is better balanced.
    threshold = float(os.environ.get("KLAKET_DIARIZE_THRESHOLD", "0.8"))
    cache_key = (num_speakers, threshold)
    if cache_key not in _diarizers:
        import sherpa_onnx

        segmentation, embedding = _ensure_models()
        if num_speakers > 0:
            clustering = sherpa_onnx.FastClusteringConfig(num_clusters=num_speakers)
        else:
            clustering = sherpa_onnx.FastClusteringConfig(threshold=threshold)
        config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                    model=str(segmentation)
                ),
            ),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(embedding)),
            clustering=clustering,
            min_duration_on=0.3,
            min_duration_off=0.5,
        )
        _diarizers[cache_key] = sherpa_onnx.OfflineSpeakerDiarization(config)
    return _diarizers[cache_key]


def run(audio_path: pathlib.Path, num_speakers: int = 0) -> list[dict]:
    """Return speaker turns: [{"start", "end", "speaker"}] with S1/S2/… labels."""
    import numpy as np

    with wave.open(str(audio_path), "rb") as wav:
        assert wav.getframerate() == 16000 and wav.getnchannels() == 1
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16)
    samples = samples.astype(np.float32) / 32768.0

    diarizer = _get_diarizer(num_speakers)
    segments = diarizer.process(samples).sort_by_start_time()
    return [
        {"start": round(s.start, 2), "end": round(s.end, 2), "speaker": f"S{s.speaker + 1}"}
        for s in segments
    ]


def _speaker_at(turns: list[dict], t: float) -> str:
    for turn in turns:
        if turn["start"] <= t <= turn["end"]:
            return turn["speaker"]
    return ""


def _majority_speaker(start: float, end: float, turns: list[dict]) -> str:
    best, best_overlap = "", 0.0
    for turn in turns:
        overlap = min(end, turn["end"]) - max(start, turn["start"])
        if overlap > best_overlap:
            best, best_overlap = turn["speaker"], overlap
    return best


SMOOTH_MAX_SECONDS = 1.2  # "opposite-labeled" chunks this short are merged into their neighbors


def _smooth_speakers(transcript: list[dict]) -> list[dict]:
    """Fix single-word speaker misattribution blips.

    Embeddings are unreliable on very short chunks; a differently labeled
    chunk under SMOOTH_MAX_SECONDS squeezed between two same-speaker segments
    is most likely the same person continuing their sentence.
    """
    for i in range(1, len(transcript) - 1):
        seg = transcript[i]
        prev_speaker = transcript[i - 1].get("speaker")
        next_speaker = transcript[i + 1].get("speaker")
        if (
            prev_speaker
            and prev_speaker == next_speaker
            and seg.get("speaker") not in (None, prev_speaker)
            and seg["end"] - seg["start"] <= SMOOTH_MAX_SECONDS
        ):
            seg["speaker"] = prev_speaker
    return transcript


def assign(transcript: list[dict], turns: list[dict]) -> list[dict]:
    """Label transcript segments with speakers; split segments at speaker changes.

    A Whisper segment can span a speaker handover (fast dialogs, interruptions).
    With word timestamps we assign each word to the turn containing its midpoint
    and split the segment wherever the speaker changes — so "who said what" is
    accurate at the word level, not just per segment.
    """
    if not turns:
        return transcript

    out: list[dict] = []
    for seg in transcript:
        fallback = _majority_speaker(seg["start"], seg["end"], turns)
        words = seg.get("words") or []
        if not words:
            if fallback:
                seg["speaker"] = fallback
            out.append(seg)
            continue

        # Group consecutive words by their speaker.
        groups: list[tuple[str, list[dict]]] = []
        for word in words:
            speaker = _speaker_at(turns, (word["start"] + word["end"]) / 2) or fallback
            if groups and groups[-1][0] == speaker:
                groups[-1][1].append(word)
            else:
                groups.append((speaker, [word]))

        if len(groups) == 1:
            if groups[0][0]:
                seg["speaker"] = groups[0][0]
            out.append(seg)
            continue

        for speaker, group_words in groups:
            piece = {
                "start": group_words[0]["start"],
                "end": group_words[-1]["end"],
                "text": " ".join(w["word"] for w in group_words),
                "words": group_words,
            }
            if speaker:
                piece["speaker"] = speaker
            out.append(piece)
    return _smooth_speakers(out)
