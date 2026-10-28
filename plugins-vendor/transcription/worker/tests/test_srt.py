"""Segment→SRT + speaker-merge pure logic (mirrors the core TS helpers)."""
from transcription_worker.srt import (
    build_srt,
    format_timestamp,
    merge_tracks,
    plain_text,
)


class TestFormatTimestamp:
    def test_zero_and_subsecond(self):
        assert format_timestamp(0) == "00:00:00,000"
        assert format_timestamp(0.5) == "00:00:00,500"

    def test_hours_minutes_seconds_millis(self):
        assert format_timestamp(3661.25) == "01:01:01,250"
        assert format_timestamp(59.999) == "00:00:59,999"

    def test_rounds_to_ms_and_clamps_negative(self):
        assert format_timestamp(1.0006) == "00:00:01,001"
        assert format_timestamp(-5) == "00:00:00,000"
        assert format_timestamp("garbage") == "00:00:00,000"


class TestBuildSrt:
    def test_numbered_cues_with_valid_timecodes(self):
        srt = build_srt(
            [
                {"start": 0, "end": 2.5, "text": "hola"},
                {"start": 2.5, "end": 4, "text": "mundo"},
            ]
        )
        assert srt == (
            "1\n00:00:00,000 --> 00:00:02,500\nhola\n\n"
            "2\n00:00:02,500 --> 00:00:04,000\nmundo\n"
        )

    def test_sorts_by_start_and_skips_empty(self):
        srt = build_srt(
            [
                {"start": 5, "end": 6, "text": "second"},
                {"start": 1, "end": 2, "text": "   "},
                {"start": 0, "end": 1, "text": "first"},
            ]
        )
        cues = srt.strip().split("\n\n")
        assert len(cues) == 2
        assert "first" in cues[0]
        assert "second" in cues[1]

    def test_speaker_prefix(self):
        srt = build_srt([{"start": 0, "end": 1, "text": "hi", "speaker": "alice"}])
        assert "[alice] hi" in srt

    def test_minimum_cue_duration(self):
        srt = build_srt([{"start": 10, "end": 10, "text": "blip"}])
        assert "00:00:10,000 --> 00:00:10,500" in srt

    def test_empty_input(self):
        assert build_srt([]) == ""
        assert build_srt([{"start": 0, "end": 1, "text": ""}]) == ""


class TestSpeakerSplit:
    TRACKS = [
        {
            "speaker": "alice",
            "segments": [
                {"start": 4, "end": 5, "text": "and back to me"},
                {"start": 0, "end": 1, "text": "hello"},
            ],
        },
        {"speaker": "bob", "segments": [{"start": 2, "end": 3, "text": "hi alice"}]},
        {"speaker": None, "segments": []},
    ]

    def test_merge_is_chronological_with_speakers(self):
        merged = merge_tracks(self.TRACKS)
        assert [s["text"] for s in merged] == [
            "hello",
            "hi alice",
            "and back to me",
        ]
        assert [s["speaker"] for s in merged] == ["alice", "bob", "alice"]

    def test_merged_srt_carries_speaker_prefixes(self):
        srt = build_srt(merge_tracks(self.TRACKS))
        assert "[alice] hello" in srt
        assert "[bob] hi alice" in srt

    def test_plain_text_lines(self):
        assert plain_text(merge_tracks(self.TRACKS)) == (
            "[alice] hello\n[bob] hi alice\n[alice] and back to me"
        )

    def test_plain_text_without_speaker(self):
        assert plain_text([{"start": 0, "end": 1, "text": "mixed"}]) == "mixed"
