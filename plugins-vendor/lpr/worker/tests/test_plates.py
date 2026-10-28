from lpr_worker.plates import (
    events_for,
    match_list,
    normalize_plate,
    parse_plate_list,
)


def test_normalize_uppercases_and_strips_separators():
    assert normalize_plate("ab-123 cd") == "AB123CD"
    assert normalize_plate(" aa · 000 · aa ") == "AA000AA"
    assert normalize_plate("AB.123.CD") == "AB123CD"
    assert normalize_plate("AB123CD") == "AB123CD"


def test_normalize_handles_garbage():
    assert normalize_plate("") == ""
    assert normalize_plate("---") == ""
    assert normalize_plate(None) == ""
    assert normalize_plate(123) == ""


def test_parse_plate_list_splits_on_commas_semicolons_newlines():
    raw = "ab123cd, XX999XX;aa 000 aa\nZZ111ZZ"
    assert parse_plate_list(raw) == ["AB123CD", "XX999XX", "AA000AA", "ZZ111ZZ"]


def test_parse_plate_list_dedupes_after_normalization():
    assert parse_plate_list("AB123CD, ab-123-cd,AB 123 CD") == ["AB123CD"]


def test_parse_plate_list_empty_inputs():
    assert parse_plate_list("") == []
    assert parse_plate_list("  ,;\n ") == []
    assert parse_plate_list(None) == []


def test_match_list_verdicts():
    wl = ["AB123CD"]
    bl = ["XX999XX"]
    assert match_list("AB123CD", wl, bl) == "whitelist"
    assert match_list("XX999XX", wl, bl) == "blacklist"
    assert match_list("ZZ111ZZ", wl, bl) is None


def test_match_list_blacklist_wins_when_on_both():
    assert match_list("AB123CD", ["AB123CD"], ["AB123CD"]) == "blacklist"


def test_events_for_families():
    assert events_for(None) == ["plate.detected"]
    assert events_for("whitelist") == ["plate.detected", "plate.allowed"]
    assert events_for("blacklist") == ["plate.detected", "plate.denied"]
