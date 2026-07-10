"""The Klaket pipeline: ingest -> audio -> transcribe -> scenes -> keyframes -> assemble.

Design principle: every stage below runs locally with zero LLM/API calls ("lite mode").
The pluggable model layer (VLM scene descriptions, summaries) arrives in v0.2 and
must remain strictly optional.
"""

import datetime
import json
import logging
import pathlib
import shutil
import subprocess

from . import __version__, diarize, ocr, translate, vlm


class StageError(RuntimeError):
    """A pipeline stage failed with a user-facing message."""


def run(
    job_id: str, url: str, language: str, data_dir: str, on_progress,
    model: str = "", prompt: str = "", num_speakers: int = 0, translate_to: str = "",
) -> dict:
    """Execute the full pipeline. Returns job metadata (title, duration)."""
    job_dir = pathlib.Path(data_dir) / "jobs" / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    on_progress("ingest", 0.05)
    source, meta = _ingest(url, job_dir)
    _check_duration(meta)
    # Podcast/audio-only support: skip the visual stages when there is no video stream.
    has_video = bool(_probe_codec(source))
    if has_video:
        source = _normalize_source(source, job_dir)

    on_progress("audio", 0.20)
    audio = _extract_audio(source, job_dir)

    on_progress("transcribe", 0.30)
    transcript, detected_lang = _transcribe(audio, language, model, prompt)

    if diarize.enabled() and transcript:
        on_progress("diarize", 0.62)
        try:
            transcript = diarize.assign(transcript, diarize.run(audio, num_speakers))
        except Exception as exc:  # fail-soft: a speakerless transcript is still useful
            logging.getLogger("klaket.pipeline").warning("diarization skipped: %s", exc)

    translated_to = ""
    if translate_to and transcript and translate_to != detected_lang:
        on_progress("translate", 0.7)
        try:
            translations = translate.translate_texts(
                [seg["text"] for seg in transcript], detected_lang, translate_to
            )
            for seg, translated in zip(transcript, translations):
                seg["translated"] = translated
            translated_to = translate_to
        except Exception as exc:  # fail-soft: the original transcript is always kept
            logging.getLogger("klaket.pipeline").warning("translation skipped: %s", exc)

    if has_video:
        on_progress("scenes", 0.75)
        scenes = _detect_scenes(source)

        on_progress("keyframes", 0.82)
        _extract_keyframes(source, scenes, job_dir)

        on_progress("enrich", 0.88)
        _enrich_scenes(source, scenes, job_dir, detected_lang)
    else:
        scenes = []

    on_progress("assemble", 0.95)
    result = {
        "id": job_id,
        "url": url,
        "title": meta.get("title", ""),
        "duration": meta.get("duration", 0.0),
        "language": detected_lang,
        "media_file": source.name,
        "translated_to": translated_to,
        "transcript": transcript,
        "scenes": scenes,
        "chapters": _build_chapters(transcript, scenes),
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(
            timespec="seconds"
        ),
        "klaket_version": __version__,
    }
    (job_dir / "result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (job_dir / "result.md").write_text(_to_markdown(result), encoding="utf-8")
    _write_subtitles(transcript, job_dir)
    if translated_to:
        _write_subtitles(transcript, job_dir, suffix=f".{translated_to}", text_key="translated")
    return meta


# --- stages ---


def _ingest(url: str, job_dir: pathlib.Path) -> tuple[pathlib.Path, dict]:
    """Fetch the source video: remote URL via yt-dlp, or a local file path."""
    target = job_dir / "source.mp4"
    if url.startswith(("http://", "https://")):
        info_path = job_dir / "source.info.json"
        cmd = [
            "yt-dlp",
            "--no-playlist",
            # Prefer H.264 (avc1): OpenCV/scenedetect cannot decode AV1.
            "-f", "bv*[vcodec^=avc1][height<=720]+ba/bv*[height<=720]+ba/b[height<=720]/b",
            "--merge-output-format", "mp4",
            "--write-info-json",
            "-o", str(target),
            url,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0 or not target.exists():
            raise StageError(f"download failed: {_tail(proc.stderr)}")
        meta = {}
        if info_path.exists():
            info = json.loads(info_path.read_text(encoding="utf-8"))
            meta = {"title": info.get("title", ""), "duration": float(info.get("duration") or 0)}
        return target, meta

    # Local path (mounted into the container, e.g. under /data).
    src = pathlib.Path(url)
    if not src.exists():
        raise StageError(f"local file not found: {url}")
    # Keep the extension: audio-only files (mp3/m4a) cannot be served under an mp4 name.
    target = job_dir / f"source{src.suffix.lower() or '.mp4'}"
    shutil.copyfile(src, target)
    return target, {"title": src.stem, "duration": _probe_duration(target)}


def _normalize_source(source: pathlib.Path, job_dir: pathlib.Path) -> pathlib.Path:
    """Safety net: transcode codecs OpenCV cannot decode (AV1) to H.264.

    ffmpeg (with dav1d) can decode AV1, but the OpenCV that scenedetect uses
    cannot — without transcoding, scene detection silently finds zero scenes.
    """
    if _probe_codec(source) != "av1":
        return source
    logging.getLogger("klaket.pipeline").info("transcoding AV1 source to H.264…")
    normalized = job_dir / "source_h264.mp4"
    _ffmpeg(
        "-i", str(source),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "copy",
        str(normalized),
    )
    source.unlink(missing_ok=True)
    normalized.rename(source)
    return source


def _probe_codec(path: pathlib.Path) -> str:
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=codec_name",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True,
    )
    return proc.stdout.strip()


def _extract_audio(source: pathlib.Path, job_dir: pathlib.Path) -> pathlib.Path:
    audio = job_dir / "audio.wav"
    _ffmpeg("-i", str(source), "-vn", "-ac", "1", "-ar", "16000", str(audio))
    return audio


_whisper_models: dict = {}


def _check_duration(meta: dict) -> None:
    """Guard against runaway jobs: reject videos over KLAKET_MAX_DURATION seconds."""
    import os

    max_seconds = float(os.environ.get("KLAKET_MAX_DURATION", "0") or 0)
    duration = float(meta.get("duration") or 0)
    if max_seconds > 0 and duration > max_seconds:
        raise StageError(
            f"video too long: {duration:.0f}s exceeds the {max_seconds:.0f}s limit"
        )


def _transcribe(
    audio: pathlib.Path, language: str, model_name: str = "", prompt: str = ""
) -> tuple[list[dict], str]:
    # Imported lazily: loading the model takes seconds and pulls in heavy deps.
    from faster_whisper import WhisperModel
    import os

    name = model_name or os.environ.get("WHISPER_MODEL", "small")
    if name not in _whisper_models:
        _whisper_models[name] = WhisperModel(
            name,
            device=os.environ.get("WHISPER_DEVICE", "cpu"),
            compute_type=os.environ.get("WHISPER_COMPUTE", "int8"),
        )
    model = _whisper_models[name]
    lang = None if language in ("", "auto") else language
    segments, info = model.transcribe(
        str(audio),
        language=lang,
        vad_filter=True,
        word_timestamps=True,
        # Anti-hallucination: conditioning on previous text produces repetition loops.
        condition_on_previous_text=False,
        # Context hint: noticeably improves accuracy on proper nouns/jargon.
        initial_prompt=prompt or None,
    )
    transcript = []
    for seg in segments:
        text = seg.text.strip()
        if not text:  # skip empty/hallucinated segments
            continue
        words = [
            {"word": w.word.strip(), "start": round(w.start, 2), "end": round(w.end, 2)}
            for w in (seg.words or [])
        ]
        transcript.append({
            "start": round(seg.start, 2),
            "end": round(seg.end, 2),
            "text": text,
            "words": words,
        })
    return transcript, info.language


def _detect_scenes(source: pathlib.Path) -> list[dict]:
    # AdaptiveDetector: rolling-window ratio comparison — far more accurate than the
    # fixed-threshold ContentDetector on dark/similar-toned real content (shows, vlogs).
    from scenedetect import AdaptiveDetector, detect

    boundaries = detect(str(source), AdaptiveDetector())
    scenes = [
        {
            "index": i,
            "start": round(start.get_seconds(), 2),
            "end": round(end.get_seconds(), 2),
            "keyframe": f"scene_{i:03d}.jpg",
        }
        for i, (start, end) in enumerate(boundaries)
    ]
    if not scenes:  # short/static clips: treat the whole video as one scene
        scenes = [{
            "index": 0,
            "start": 0.0,
            "end": _probe_duration(source),
            "keyframe": "scene_000.jpg",
        }]
    return scenes


def _extract_keyframes(source: pathlib.Path, scenes: list[dict], job_dir: pathlib.Path) -> None:
    for scene in scenes:
        midpoint = (scene["start"] + scene["end"]) / 2
        _extract_frame(source, midpoint, 640, job_dir / scene["keyframe"])


def _extract_frame(source: pathlib.Path, at: float, width: int, out: pathlib.Path) -> None:
    # The thumbnail filter picks the most representative (non-blurry) frame from a
    # 2-second window — noticeably better than a random frame at the scene midpoint.
    start = max(0.0, at - 1.0)
    _ffmpeg(
        "-ss", f"{start:.2f}", "-t", "2", "-i", str(source),
        "-vf", f"thumbnail=50,scale={width}:-2", "-frames:v", "1",
        str(out),
    )


def _enrich_scenes(
    source: pathlib.Path, scenes: list[dict], job_dir: pathlib.Path, language: str = "en"
) -> None:
    """Optional per-keyframe enrichment: on-screen OCR and VLM descriptions.

    OCR runs on a temporary 1280px frame: small on-screen text (terminals,
    captions) is unreadable at thumbnail resolution.
    """
    run_ocr, run_vlm = ocr.enabled(), vlm.enabled()
    ocr_frame = job_dir / "_ocr_frame.jpg"
    try:
        for scene in scenes:
            keyframe = job_dir / scene["keyframe"]
            scene["ocr"] = ""
            if run_ocr:
                midpoint = (scene["start"] + scene["end"]) / 2
                _extract_frame(source, midpoint, 1280, ocr_frame)
                scene["ocr"] = ocr.read_text(ocr_frame)
            scene["description"] = (
                vlm.describe(keyframe, language) if run_vlm and keyframe.exists() else ""
            )
    finally:
        ocr_frame.unlink(missing_ok=True)


MIN_SILENT_CHAPTER_SECONDS = 20.0  # minimum duration per chapter in silent videos


def _build_chapters(transcript: list[dict], scenes: list[dict]) -> list[dict]:
    """Auto-chapters.

    A chapter is not a camera cut: one chapter per scene produces spam on
    fast-cut videos (e.g. a 5-min TV clip = 71 scenes). When there is speech,
    chapters are derived from speech pauses (they converge on topics); in
    silent videos, scenes are grouped until they reach a minimum duration.
    """
    if transcript:
        return _chapters_from_pauses(transcript)
    return _merged_scene_chapters(scenes)


def _merged_scene_chapters(scenes: list[dict]) -> list[dict]:
    """Silent video: merge consecutive scenes into ~MIN_SILENT_CHAPTER_SECONDS chapters."""
    chapters: list[dict] = []
    group_start: float | None = None
    first_idx = 0
    for i, scene in enumerate(scenes):
        if group_start is None:
            group_start = scene["start"]
            first_idx = scene["index"]
        is_last = i == len(scenes) - 1
        if scene["end"] - group_start >= MIN_SILENT_CHAPTER_SECONDS or is_last:
            chapters.append({
                "index": len(chapters),
                "start": group_start,
                "end": scene["end"],
                "title": f"Scenes {first_idx}–{scene['index']}"
                if scene["index"] != first_idx else f"Scene {first_idx}",
                "segments": 0,
            })
            group_start = None
    return chapters


MAX_CUE_CHARS = 84  # common subtitle standard: ~42 characters × 2 lines


def _split_cues(transcript: list[dict]) -> list[dict]:
    """Break long segments into subtitle-friendly cues using word timestamps."""
    cues = []
    for seg in transcript:
        speaker = seg.get("speaker", "")
        words = seg.get("words") or []
        if len(seg["text"]) <= MAX_CUE_CHARS or not words:
            cues.append({"start": seg["start"], "end": seg["end"],
                         "speaker": speaker, "text": seg["text"]})
            continue
        chunk: list[str] = []
        start = end = seg["start"]
        for word in words:
            if chunk and len(" ".join(chunk + [word["word"]])) > MAX_CUE_CHARS:
                cues.append({"start": start, "end": end,
                             "speaker": speaker, "text": " ".join(chunk)})
                chunk, start = [], word["start"]
            chunk.append(word["word"])
            end = word["end"]
        if chunk:
            cues.append({"start": start, "end": end,
                         "speaker": speaker, "text": " ".join(chunk)})
    return cues


PAUSE_CHAPTER_GAP = 3.0  # seconds — this much silence starts a new chapter


def _chapters_from_pauses(transcript: list[dict], gap: float = PAUSE_CHAPTER_GAP) -> list[dict]:
    """Podcast chapters: split on long pauses, title with the first sentence."""
    groups: list[list[dict]] = []
    current: list[dict] = []
    for seg in transcript:
        if current and seg["start"] - current[-1]["end"] >= gap:
            groups.append(current)
            current = []
        current.append(seg)
    if current:
        groups.append(current)

    chapters = []
    for i, group in enumerate(groups):
        title = group[0]["text"]
        if len(title) > 60:
            title = title[:57].rstrip() + "…"
        chapters.append({
            "index": i,
            "start": group[0]["start"],
            "end": group[-1]["end"],
            "title": title,
            "segments": len(group),
        })
    return chapters


def _write_subtitles(
    transcript: list[dict], job_dir: pathlib.Path, suffix: str = "", text_key: str = "text"
) -> None:
    """Render the transcript as subtitles{suffix}.srt/vtt.

    text_key="translated" produces translated subtitles; segments without a
    translation fall back to the original text.
    """

    def stamp(t: float, sep: str) -> str:
        h, rem = divmod(int(t), 3600)
        m, s = divmod(rem, 60)
        ms = int(round((t - int(t)) * 1000))
        return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"

    source = transcript
    if text_key != "text":
        source = [{**seg, "text": seg.get(text_key) or seg["text"]} for seg in transcript]

    srt, vtt = [], ["WEBVTT", ""]
    for i, cue in enumerate(_split_cues(source), start=1):
        speaker = f"{cue['speaker']}: " if cue["speaker"] else ""
        srt += [str(i), f"{stamp(cue['start'], ',')} --> {stamp(cue['end'], ',')}",
                speaker + cue["text"], ""]
        vtt += [f"{stamp(cue['start'], '.')} --> {stamp(cue['end'], '.')}",
                speaker + cue["text"], ""]
    (job_dir / f"subtitles{suffix}.srt").write_text("\n".join(srt), encoding="utf-8")
    (job_dir / f"subtitles{suffix}.vtt").write_text("\n".join(vtt), encoding="utf-8")


def _to_markdown(result: dict) -> str:
    """Human/LLM friendly markdown rendering of the result."""
    lines = [f"# {result['title'] or result['id']}", ""]
    lines.append(f"- Duration: {result['duration']:.0f}s · Language: {result['language']}")
    lines.append(f"- Scenes: {len(result['scenes'])} · Source: {result['url']}")
    if result.get("chapters"):
        lines.append("\n## Chapters\n")
        for ch in result["chapters"]:
            lines.append(f"- `[{_ts(ch['start'])} → {_ts(ch['end'])}]` {ch['title']}")
    lines.append("\n## Transcript\n")
    for seg in result["transcript"]:
        speaker = f"**{seg['speaker']}**: " if seg.get("speaker") else ""
        lines.append(f"`[{_ts(seg['start'])} → {_ts(seg['end'])}]` {speaker}{seg['text']}")
    lines.append("\n## Scenes\n")
    for scene in result["scenes"]:
        lines.append(
            f"- Scene {scene['index']}: `{_ts(scene['start'])} → {_ts(scene['end'])}`"
            f" (keyframe: {scene['keyframe']})"
        )
        if scene.get("description"):
            lines.append(f"  - Looks like: {scene['description']}")
        if scene.get("ocr"):
            lines.append(f"  - On-screen text: {scene['ocr']}")
    return "\n".join(lines) + "\n"


# --- helpers ---


def _ffmpeg(*args: str) -> None:
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise StageError(f"ffmpeg failed: {_tail(proc.stderr)}")


def _probe_duration(path: pathlib.Path) -> float:
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True,
    )
    try:
        return round(float(proc.stdout.strip()), 2)
    except ValueError:
        return 0.0


def _ts(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def _tail(text: str, lines: int = 5) -> str:
    return "\n".join((text or "").strip().splitlines()[-lines:])
