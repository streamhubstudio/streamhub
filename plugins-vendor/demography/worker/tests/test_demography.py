"""Demography — gender/age/emotion mapping, AI parse, budget guard."""
import os
import tempfile

from vision_edge.models.demography import (
    BudgetGuard,
    DemographyConfig,
    age_range,
    build_face_event,
    build_vision_messages,
    dominant_emotion,
    map_gender,
    parse_ai_response,
    remap_hsemotion,
)


def test_map_gender_male_needs_high_threshold():
    assert map_gender(0.96, 0.04)[0] == "male"
    # Just under the 0.95 male threshold → unknown (buffalo male-bias guard).
    assert map_gender(0.90, 0.10)[0] == "unknown"


def test_map_gender_female_low_threshold():
    assert map_gender(0.6, 0.4)[0] == "unknown"   # male 0.6 < 0.95; female 0.4 not > male
    assert map_gender(0.2, 0.8)[0] == "female"     # female 0.8 >= 0.3 and > male
    # male dominant but under 0.95, female under nothing wins → unknown at max conf.
    g, conf = map_gender(0.65, 0.35)
    assert g == "unknown" and conf == 65.0


def test_map_gender_female_beats_male_when_over_threshold():
    g, conf = map_gender(0.2, 0.35)
    assert g == "female" and conf == 35.0


def test_age_range_buckets():
    assert age_range(5) == "0-12"
    assert age_range(15) == "13-17"
    assert age_range(22) == "18-24"
    assert age_range(30) == "25-34"
    assert age_range(70) == "65+"


def test_remap_hsemotion_folds_contempt_and_normalizes():
    scores8 = {"Anger": 10, "Contempt": 5, "Disgust": 5, "Fear": 0, "Happiness": 30, "Neutral": 40, "Sadness": 10, "Surprise": 0}
    out = remap_hsemotion(scores8)
    assert set(out.keys()) == {"angry", "disgust", "fear", "happy", "neutral", "sad", "surprise"}
    assert abs(sum(out.values()) - 100.0) < 1e-6
    assert abs(out["disgust"] - 10.0) < 1e-6   # contempt(5)+disgust(5) normalized (total 100)


def test_dominant_emotion_argmax():
    name, conf = dominant_emotion({"happy": 60, "neutral": 30, "angry": 10})
    assert name == "happy" and conf == 60.0


def test_dominant_emotion_anti_angry_rule():
    # angry is top but neutral/angry >= 0.7 → relabel neutral.
    name, _ = dominant_emotion({"angry": 40, "neutral": 35, "happy": 25})
    assert name == "neutral"
    # angry clearly dominant → stays angry.
    name2, _ = dominant_emotion({"angry": 80, "neutral": 10})
    assert name2 == "angry"


def test_parse_ai_response_plain_json():
    rec = parse_ai_response('{"age": 27, "gender": "female", "emotion": "happy", "genderConfidence": 88, "emotionConfidence": 70}')
    assert rec["age"] == 27 and rec["ageRange"] == "25-34"
    assert rec["gender"] == "female" and rec["genderConfidence"] == 88.0
    assert rec["emotion"] == "happy"


def test_parse_ai_response_code_fence_and_prose():
    content = 'Here is the result:\n```json\n{"age": 41, "gender": "male"}\n```\nThanks!'
    rec = parse_ai_response(content)
    assert rec["age"] == 41 and rec["ageRange"] == "35-44" and rec["gender"] == "male"


def test_parse_ai_response_no_face_and_garbage():
    assert parse_ai_response('{"age": null}') is None
    assert parse_ai_response("no json here") is None
    assert parse_ai_response("") is None


def test_parse_ai_response_bad_gender_defaults_unknown():
    rec = parse_ai_response('{"age": 20, "gender": "robot"}')
    assert rec["gender"] == "unknown"


def test_build_vision_messages_shape():
    msgs = build_vision_messages("describe", "QUJD")
    assert msgs[0]["role"] == "user"
    parts = msgs[0]["content"]
    assert parts[0]["text"] == "describe"
    assert parts[1]["image_url"]["url"].startswith("data:image/jpeg;base64,QUJD")


def test_build_face_event_shape():
    rec = {"age": 30, "ageRange": "25-34", "gender": "male", "genderConfidence": 90, "emotion": "neutral", "emotionConfidence": 55}
    ev = build_face_event(rec, "openai", tag="entrance")
    assert ev["engine"] == "openai" and ev["tag"] == "entrance"
    assert ev["age"] == 30 and ev["gender"] == "male"


def test_build_face_event_carries_poi_and_defaults_tag():
    rec = {"age": 30, "ageRange": "25-34", "gender": "male", "genderConfidence": 90, "emotion": "neutral", "emotionConfidence": 55}
    ev = build_face_event(rec, "local", poi="till-2")
    assert ev["poi"] == "till-2"
    assert ev["tag"] == "till-2"                   # tag defaults to the POI name
    # No POI + no tag → neither key present (whole-frame face).
    plain = build_face_event(rec, "local")
    assert "poi" not in plain and "tag" not in plain


def test_budget_guard_blocks_over_cap():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "budget.json")
        clk = {"t": 1_700_000_000.0}  # fixed instant
        g = BudgetGuard(path, monthly_budget=0.05, clock=lambda: clk["t"])
        assert g.can_spend(0.01) is True
        g.record(0.01)
        g.record(0.03)
        assert g.spent() == 0.04
        assert g.can_spend(0.01) is True     # 0.04 + 0.01 = 0.05 <= cap
        assert g.can_spend(0.02) is False    # 0.06 > cap


def test_budget_guard_persists_and_reloads():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "budget.json")
        t = 1_700_000_000.0
        g1 = BudgetGuard(path, 1.0, clock=lambda: t)
        g1.record(0.25)
        g2 = BudgetGuard(path, 1.0, clock=lambda: t)  # fresh instance, same file
        assert g2.spent() == 0.25


def test_budget_guard_month_rollover_resets():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "budget.json")
        clk = {"t": 1_700_000_000.0}  # ~Nov 2023
        g = BudgetGuard(path, 1.0, clock=lambda: clk["t"])
        g.record(0.9)
        assert g.spent() == 0.9
        clk["t"] = 1_704_200_000.0  # ~Jan 2024, a later month
        assert g.spent() == 0.0     # rolled over


def test_budget_guard_disabled_when_zero():
    g = BudgetGuard("", monthly_budget=0.0)
    assert g.enabled is False
    assert g.can_spend(1000.0) is True


def test_demography_config_from_dict():
    cfg = DemographyConfig.from_dict({
        "engine": "openai",
        "intervalSec": 60,
        "roi": {"points": [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9]]},
        "aiPrompt": "custom",
        "aiBudgetMonthly": 25,
    })
    assert cfg.engine == "openai" and cfg.interval_sec == 60.0
    assert cfg.ai_prompt == "custom" and cfg.ai_budget_monthly == 25.0
    assert len(cfg.roi) == 3


def test_demography_config_bad_engine_falls_back():
    cfg = DemographyConfig.from_dict({"engine": "gemini"})
    assert cfg.engine == "local"


def test_demography_config_parses_pois_and_keeps_roi():
    cfg = DemographyConfig.from_dict({
        "roi": {"points": [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9]]},
        "pois": [{"id": "till", "tag": "checkout", "points": [[0.6, 0.0], [1.0, 0.0], [1.0, 1.0], [0.6, 1.0]]}],
    })
    assert len(cfg.roi) == 3                       # legacy ROI still parsed
    assert len(cfg.pois) == 1 and cfg.pois[0].name == "checkout"
    # Backward compatible: no `pois` → empty (whole frame).
    assert DemographyConfig.from_dict({}).pois == []
