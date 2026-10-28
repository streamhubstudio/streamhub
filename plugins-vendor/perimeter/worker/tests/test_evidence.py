from perimeter_worker.evidence import (
    build_clip_command,
    evidence_paths,
    parse_playlist_segments,
    segments_for_clip,
)

PLAYLIST = """#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:120
#EXTINF:4.000,
seg-120.ts
#EXTINF:4.000,
seg-121.ts
#EXTINF:4.000,
seg-122.ts
#EXTINF:2.500,
seg-123.ts
"""


def test_evidence_paths_are_stamped_and_slugged():
    ts = 1783035000.123  # any fixed unix instant
    jpg, mp4 = evidence_paths("/data/apps/live/perimeter", ts, "Front Gate #1")
    assert jpg.endswith("-front-gate-1.jpg")
    assert mp4 == jpg[:-4] + ".mp4"
    assert "/evidence/" in jpg
    assert jpg.startswith("/data/apps/live/perimeter/evidence/")
    # millisecond suffix separates same-second alerts
    jpg2, _ = evidence_paths("/data/apps/live/perimeter", ts + 0.5, "Front Gate #1")
    assert jpg2 != jpg


def test_parse_playlist_segments():
    segs = parse_playlist_segments(PLAYLIST)
    assert segs == [
        ("seg-120.ts", 4.0),
        ("seg-121.ts", 4.0),
        ("seg-122.ts", 4.0),
        ("seg-123.ts", 2.5),
    ]
    assert parse_playlist_segments("") == []
    assert parse_playlist_segments("#EXTM3U\n#EXT-X-ENDLIST\n") == []


def test_segments_for_clip_takes_the_tail_covering_the_window():
    segs = parse_playlist_segments(PLAYLIST)
    # 10s: 2.5 + 4 + 4 = 10.5 ≥ 10 → last three segments, in play order
    assert segments_for_clip(segs, 10) == ["seg-121.ts", "seg-122.ts", "seg-123.ts"]
    # tiny window still returns at least the newest segment
    assert segments_for_clip(segs, 1) == ["seg-123.ts"]
    # more than available → everything
    assert segments_for_clip(segs, 999) == [s for s, _ in segs]
    assert segments_for_clip([], 10) == []
    assert segments_for_clip(segs, 0) == []


def test_build_clip_command_is_copy_concat():
    cmd = build_clip_command(["/hls/a.ts", "/hls/b.ts"], "/ev/out.mp4")
    assert cmd[0] == "ffmpeg"
    assert "-c" in cmd and cmd[cmd.index("-c") + 1] == "copy"
    assert "concat:/hls/a.ts|/hls/b.ts" in cmd
    assert cmd[-1] == "/ev/out.mp4"
