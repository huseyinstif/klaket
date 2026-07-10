"""Unit tests for the pure parts of the pipeline (no ffmpeg/models needed)."""

import pytest

from klaket_worker import diarize, ocr, playlist, vlm
from klaket_worker.pipeline import StageError, _check_duration
from klaket_worker.pipeline import (
    MAX_CUE_CHARS,
    _build_chapters,
    _chapters_from_pauses,
    _split_cues,
    _tail,
    _to_markdown,
    _ts,
    _write_subtitles,
)


class TestTimestamp:
    def test_seconds_only(self):
        assert _ts(0) == "00:00"
        assert _ts(59.9) == "00:59"

    def test_minutes(self):
        assert _ts(75) == "01:15"

    def test_hours(self):
        assert _ts(3665) == "01:01:05"


class TestChapters:
    TRANSCRIPT = [
        {"start": 0.0, "end": 5.0, "text": "Welcome to the demo."},
        {"start": 5.0, "end": 11.0, "text": "First scene talk."},
        {"start": 16.0, "end": 20.0, "text": "Second topic starts."},  # 5s pause
    ]
    SCENES = [{"index": i, "start": i * 4.0, "end": (i + 1) * 4.0} for i in range(12)]  # 48s, 12 fast cuts

    def test_speech_video_uses_pause_chapters_not_scene_spam(self):
        # 12 scenes but 2 speech blocks -> 2 chapters (NO chapter-per-scene)
        chapters = _build_chapters(self.TRANSCRIPT, self.SCENES)
        assert len(chapters) == 2
        assert chapters[0]["title"] == "Welcome to the demo."
        assert chapters[1]["title"] == "Second topic starts."

    def test_silent_video_merges_scenes_by_duration(self):
        chapters = _build_chapters([], self.SCENES)
        # 48s / 20s minimum -> 2-3 chapters; each chapter >= 20s (except the last)
        assert 2 <= len(chapters) <= 3
        assert all(ch["end"] - ch["start"] >= 20.0 for ch in chapters[:-1])
        assert chapters[0]["title"].startswith("Scene")

    def test_long_title_truncated(self):
        transcript = [{"start": 0.0, "end": 5.0, "text": "x" * 100}]
        chapters = _build_chapters(transcript, [{"index": 0, "start": 0.0, "end": 12.0}])
        assert len(chapters[0]["title"]) <= 60
        assert chapters[0]["title"].endswith("…")


class TestMarkdown:
    def test_includes_chapters_and_ocr(self):
        result = {
            "id": "abc", "url": "u", "title": "Demo", "duration": 22.0, "language": "en",
            "transcript": [{"start": 0.0, "end": 5.0, "text": "Hello."}],
            "scenes": [{
                "index": 0, "start": 0.0, "end": 22.0, "keyframe": "scene_000.jpg",
                "ocr": "docker compose up", "description": "a terminal window",
            }],
            "chapters": [{"index": 0, "start": 0.0, "end": 22.0, "title": "Hello.", "segments": 1}],
        }
        md = _to_markdown(result)
        assert "## Chapters" in md
        assert "On-screen text: docker compose up" in md
        assert "Looks like: a terminal window" in md
        assert "Hello." in md


class TestPlaylist:
    def test_detection(self):
        assert playlist.is_playlist("https://www.youtube.com/playlist?list=PL6B39")
        assert playlist.is_playlist("https://www.youtube.com/watch?v=abc&list=PLxyz")
        assert not playlist.is_playlist("https://www.youtube.com/watch?v=abc")
        assert not playlist.is_playlist("/data/samples/dialog.mp4")

    def test_limit_env(self, monkeypatch):
        monkeypatch.setenv("KLAKET_PLAYLIST_LIMIT", "7")
        assert playlist.limit() == 7
        monkeypatch.setenv("KLAKET_PLAYLIST_LIMIT", "9999")
        assert playlist.limit() == playlist.HARD_LIMIT


class TestOcrNoiseFilter:
    def test_single_chars_rejected(self):
        assert not ocr._meaningful("C")
        assert not ocr._meaningful("米")
        assert not ocr._meaningful("~!")

    def test_real_words_kept(self):
        assert ocr._meaningful("docker")
        assert ocr._meaningful("Ep 12")
        assert ocr._meaningful("福利彩票")  # real multi-character CJK text is kept


class TestEnvFlags:
    def test_ocr_enabled_default(self, monkeypatch):
        monkeypatch.delenv("KLAKET_OCR", raising=False)
        assert ocr.enabled() is True

    def test_ocr_disabled_variants(self, monkeypatch):
        for value in ("off", "0", "false", "OFF"):
            monkeypatch.setenv("KLAKET_OCR", value)
            assert ocr.enabled() is False

    def test_vlm_off_by_default(self, monkeypatch):
        monkeypatch.delenv("KLAKET_VLM", raising=False)
        assert vlm.enabled() is False

    def test_vlm_modes(self, monkeypatch):
        monkeypatch.setenv("KLAKET_VLM", "ollama")
        assert vlm.enabled() is True
        monkeypatch.setenv("KLAKET_VLM", "openai")
        assert vlm.enabled() is True
        monkeypatch.setenv("KLAKET_VLM", "banana")
        assert vlm.enabled() is False


class TestPauseChapters:
    def test_splits_on_long_pause(self):
        transcript = [
            {"start": 0.0, "end": 4.0, "text": "Intro konusu."},
            {"start": 5.0, "end": 9.0, "text": "Devam ediyor."},   # 1s gap: same chapter
            {"start": 14.0, "end": 20.0, "text": "Yeni konu başlıyor."},  # 5s gap: new chapter
        ]
        chapters = _chapters_from_pauses(transcript)
        assert len(chapters) == 2
        assert chapters[0]["title"] == "Intro konusu."
        assert chapters[0]["segments"] == 2
        assert chapters[1]["start"] == 14.0
        assert chapters[1]["title"] == "Yeni konu başlıyor."

    def test_empty_transcript(self):
        assert _chapters_from_pauses([]) == []

    def test_build_chapters_falls_back_when_no_scenes(self):
        transcript = [{"start": 0.0, "end": 2.0, "text": "Merhaba."}]
        chapters = _build_chapters(transcript, [])
        assert len(chapters) == 1
        assert chapters[0]["title"] == "Merhaba."


class TestSubtitles:
    def test_srt_and_vtt_written(self, tmp_path):
        transcript = [
            {"start": 0.0, "end": 2.5, "text": "Hello.", "speaker": "S1"},
            {"start": 62.75, "end": 65.0, "text": "World."},
        ]
        _write_subtitles(transcript, tmp_path)
        srt = (tmp_path / "subtitles.srt").read_text(encoding="utf-8")
        vtt = (tmp_path / "subtitles.vtt").read_text(encoding="utf-8")
        assert "00:00:00,000 --> 00:00:02,500" in srt
        assert "S1: Hello." in srt
        assert "00:01:02,750 --> 00:01:05,000" in srt
        assert vtt.startswith("WEBVTT")
        assert "00:01:02.750 --> 00:01:05.000" in vtt
        assert "World." in vtt  # no speaker prefix when unlabeled


class TestCueSplitting:
    def test_short_segment_stays_single_cue(self):
        transcript = [{"start": 0.0, "end": 2.0, "text": "Short line.", "words": []}]
        cues = _split_cues(transcript)
        assert len(cues) == 1
        assert cues[0]["text"] == "Short line."

    def test_long_segment_split_by_words(self):
        words = [
            {"word": f"word{i:02d}", "start": float(i), "end": float(i) + 0.9}
            for i in range(30)
        ]
        text = " ".join(w["word"] for w in words)  # ~209 characters
        transcript = [{"start": 0.0, "end": 30.0, "text": text, "words": words, "speaker": "S1"}]
        cues = _split_cues(transcript)
        assert len(cues) >= 3
        assert all(len(c["text"]) <= MAX_CUE_CHARS for c in cues)
        # timestamps must come from the words and be increasing
        assert cues[0]["start"] == 0.0
        for a, b in zip(cues, cues[1:]):
            assert a["end"] <= b["start"] + 0.01
        # no word may be lost
        assert " ".join(c["text"] for c in cues) == text
        assert all(c["speaker"] == "S1" for c in cues)

    def test_long_segment_without_words_left_intact(self):
        transcript = [{"start": 0.0, "end": 30.0, "text": "x" * 200, "words": []}]
        assert len(_split_cues(transcript)) == 1


class TestSpeakerAssignment:
    TURNS = [
        {"start": 0.0, "end": 5.0, "speaker": "S1"},
        {"start": 5.0, "end": 10.0, "speaker": "S2"},
    ]

    def test_segment_spanning_two_speakers_is_split(self):
        words = [
            {"word": "hello", "start": 1.0, "end": 2.0},
            {"word": "there", "start": 2.5, "end": 3.5},
            {"word": "hi", "start": 6.0, "end": 6.5},
            {"word": "back", "start": 7.0, "end": 7.5},
        ]
        transcript = [{"start": 1.0, "end": 7.5, "text": "hello there hi back", "words": words}]
        out = diarize.assign(transcript, self.TURNS)
        assert len(out) == 2
        assert out[0]["speaker"] == "S1" and out[0]["text"] == "hello there"
        assert out[1]["speaker"] == "S2" and out[1]["text"] == "hi back"
        assert out[0]["end"] == 3.5 and out[1]["start"] == 6.0

    def test_single_speaker_segment_stays_whole(self):
        words = [{"word": "hey", "start": 1.0, "end": 2.0}]
        transcript = [{"start": 1.0, "end": 2.0, "text": "hey", "words": words}]
        out = diarize.assign(transcript, self.TURNS)
        assert len(out) == 1 and out[0]["speaker"] == "S1"

    def test_no_words_falls_back_to_majority(self):
        transcript = [{"start": 6.0, "end": 9.0, "text": "no words here", "words": []}]
        out = diarize.assign(transcript, self.TURNS)
        assert out[0]["speaker"] == "S2"

    def test_no_turns_returns_input_unchanged(self):
        transcript = [{"start": 0.0, "end": 1.0, "text": "x", "words": []}]
        assert diarize.assign(transcript, []) == transcript

    def test_smoothing_fixes_short_speaker_blip(self):
        transcript = [
            {"start": 0.0, "end": 4.0, "text": "uzun cümle", "speaker": "S1"},
            {"start": 4.2, "end": 4.8, "text": "kısa", "speaker": "S2"},   # 0.6s blip
            {"start": 5.0, "end": 9.0, "text": "devam ediyor", "speaker": "S1"},
        ]
        out = diarize._smooth_speakers(transcript)
        assert out[1]["speaker"] == "S1"

    def test_smoothing_keeps_real_interjection(self):
        transcript = [
            {"start": 0.0, "end": 4.0, "text": "soru soruyor", "speaker": "S1"},
            {"start": 4.2, "end": 7.5, "text": "uzunca bir cevap veriyor", "speaker": "S2"},  # 3.3s: genuine
            {"start": 8.0, "end": 12.0, "text": "tekrar konuşuyor", "speaker": "S1"},
        ]
        out = diarize._smooth_speakers(transcript)
        assert out[1]["speaker"] == "S2"


class TestDurationGuard:
    def test_disabled_by_default(self, monkeypatch):
        monkeypatch.delenv("KLAKET_MAX_DURATION", raising=False)
        _check_duration({"duration": 999999})  # no exception

    def test_rejects_over_limit(self, monkeypatch):
        monkeypatch.setenv("KLAKET_MAX_DURATION", "60")
        with pytest.raises(StageError, match="video too long"):
            _check_duration({"duration": 61})
        _check_duration({"duration": 59})  # under the limit is fine


def test_tail_returns_last_lines():
    assert _tail("a\nb\nc\nd\ne\nf\ng", lines=3) == "e\nf\ng"
    assert _tail("") == ""
    assert _tail(None) == ""
