"""
Demography — age / gender / emotion per detected face, from periodic snapshots.

Two engines (Wave-2 §Q3: local default, AI-API opt-in):

* ``local``  — InsightFace ``buffalo_l`` (genderage + RetinaFace) with the
  softmax-gender + asymmetric-threshold logic ported from Vision One's
  demography model (vision_one/models/demography), plus HSEmotion (8→7 emotion
  remap with the anti-"angry" rule). InsightFace/HSEmotion imports are LAZY.
* ``openai`` / ``deepseek`` — snapshot → base64 → a Chat Completions vision
  message with the operator's ``aiPrompt`` template; the structured JSON reply
  is parsed into the same face record. A per-run BUDGET GUARD persists the
  month's estimated spend to a JSON state file and hard-stops over
  ``aiBudgetMonthly`` (scaffolded on Vision One's cloud CostTracker; there was
  no vision-LLM prior art to lift, so the request/parse is built here).

All mapping/parsing/budget logic is pure and unit-tested (no insightface, no
network). Emits ``demography.face`` events.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from typing import Any, Mapping

# Vision One demography constants (demography/model.py + insightface_backend.py).
CONFIDENCE_THRESHOLD = 0.5
GENDER_THRESHOLD_MALE = 0.95     # asymmetric — counters buffalo_l's male bias
GENDER_THRESHOLD_FEMALE = 0.30
ANGRY_TO_NEUTRAL_RATIO = 0.7     # relabel angry→neutral when neutral/angry ≥ this

# HSEmotion (8 class) → DeepFace-style 7 keys (Vision One _HSEMOTION_TO_DEEPFACE).
HSEMOTION_TO_7 = {
    "anger": "angry",
    "contempt": "disgust",
    "disgust": "disgust",
    "fear": "fear",
    "happiness": "happy",
    "neutral": "neutral",
    "sadness": "sad",
    "surprise": "surprise",
}

DEFAULT_INTERVAL_SEC = 120.0
DEFAULT_ENGINE = "local"
_ENGINES = ("local", "openai", "deepseek")

# Rough per-image cost estimate (USD) for the AI vision engines (a low-res
# snapshot ≈ a handful of image + output tokens). Operator-overridable via
# config ``aiCostPerImage``; only used to enforce the monthly budget cap.
DEFAULT_AI_COST_PER_IMAGE = 0.01


# ---------------------------------------------------------------------------
# Gender / age / emotion mapping (pure)
# ---------------------------------------------------------------------------

def map_gender(
    p_male: float,
    p_female: float,
    threshold_male: float = GENDER_THRESHOLD_MALE,
    threshold_female: float = GENDER_THRESHOLD_FEMALE,
) -> tuple[str, float]:
    """Vision One 3-way gender decision from softmax probabilities.

    Returns ``(gender, confidence%)`` where gender ∈ {'male','female','unknown'}
    ('unknown' = Vision One's 'Indefinido'). Asymmetric thresholds counter
    buffalo_l's documented male bias.
    """
    pm = max(0.0, min(1.0, float(p_male)))
    pf = max(0.0, min(1.0, float(p_female)))
    if pm >= threshold_male and pm > pf:
        return "male", round(pm * 100, 2)
    if pf >= threshold_female and pf > pm:
        return "female", round(pf * 100, 2)
    return "unknown", round(max(pm, pf) * 100, 2)


def age_range(age: float) -> str:
    """Bucket a numeric age into a labeled range string for analytics."""
    a = max(0, int(round(age)))
    buckets = [
        (12, "0-12"),
        (17, "13-17"),
        (24, "18-24"),
        (34, "25-34"),
        (44, "35-44"),
        (54, "45-54"),
        (64, "55-64"),
    ]
    for hi, label in buckets:
        if a <= hi:
            return label
    return "65+"


def dominant_emotion(scores: Mapping[str, float]) -> tuple[str, float]:
    """Argmax over 7 emotion scores (0-100) with Vision One's anti-angry rule:
    if the top emotion is 'angry' but neutral/angry ≥ 0.7, relabel to 'neutral'
    (buffalo/HSEmotion over-predicts angry on neutral faces).

    Returns ``(emotion, confidence%)``.
    """
    if not scores:
        return "neutral", 0.0
    top = max(scores.items(), key=lambda kv: kv[1])
    name, val = top[0], float(top[1])
    if name == "angry":
        angry = float(scores.get("angry", 0.0)) or 1e-9
        neutral = float(scores.get("neutral", 0.0))
        if neutral / angry >= ANGRY_TO_NEUTRAL_RATIO:
            return "neutral", round(neutral, 2)
    return name, round(val, 2)


def remap_hsemotion(scores8: Mapping[str, float]) -> dict[str, float]:
    """Fold the 8 HSEmotion scores into 7 DeepFace keys (Contempt→disgust),
    normalized to sum→100. Keys are matched case-insensitively."""
    out: dict[str, float] = {v: 0.0 for v in ("angry", "disgust", "fear", "happy", "neutral", "sad", "surprise")}
    for k, v in scores8.items():
        key = HSEMOTION_TO_7.get(str(k).strip().lower())
        if key is None:
            continue
        try:
            out[key] += float(v)
        except (TypeError, ValueError):
            continue
    total = sum(out.values())
    if total > 0:
        out = {k: round(v / total * 100, 4) for k, v in out.items()}
    return out


# ---------------------------------------------------------------------------
# AI-API engine: prompt, response parse, budget guard (pure)
# ---------------------------------------------------------------------------

DEFAULT_AI_PROMPT = (
    "You are a demographics vision analyst. Look at the person's face in the "
    "image and respond with ONLY a compact JSON object, no prose, of the form "
    '{"age": <int>, "gender": "male"|"female"|"unknown", '
    '"emotion": "happy"|"sad"|"angry"|"neutral"|"surprise"|"fear"|"disgust", '
    '"genderConfidence": <0-100>, "emotionConfidence": <0-100>}. '
    "If no face is clearly visible, respond {\"age\": null}."
)


def build_vision_messages(prompt: str, image_b64: str, mime: str = "image/jpeg") -> list[dict[str, Any]]:
    """Chat Completions vision message array (OpenAI/DeepSeek compatible)."""
    return [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt or DEFAULT_AI_PROMPT},
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{image_b64}"}},
            ],
        }
    ]


def parse_ai_response(content: str) -> dict[str, Any] | None:
    """Parse the model's reply into a face record, tolerant of code fences and
    surrounding prose. Returns None when no usable JSON / no face.
    """
    if not content:
        return None
    text = content.strip()
    # Strip ```json … ``` fences.
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    # Extract the first {...} object if there's surrounding prose.
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None
    try:
        obj = json.loads(text[start : end + 1])
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(obj, dict):
        return None
    age = obj.get("age")
    if age is None:
        return None  # explicit "no face"
    try:
        age_val = float(age)
    except (TypeError, ValueError):
        return None
    gender = str(obj.get("gender", "unknown")).strip().lower()
    if gender not in ("male", "female", "unknown"):
        gender = "unknown"
    emotion = str(obj.get("emotion", "neutral")).strip().lower()
    return {
        "age": int(round(age_val)),
        "ageRange": age_range(age_val),
        "gender": gender,
        "genderConfidence": _num(obj.get("genderConfidence"), 0.0),
        "emotion": emotion,
        "emotionConfidence": _num(obj.get("emotionConfidence"), 0.0),
    }


def _num(v: Any, default: float) -> float:
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return default


class BudgetGuard:
    """Monthly spend cap for the AI engines (scaffolded on Vision One's cloud
    CostTracker). Persists ``{"month": "YYYY-MM", "spent": <usd>}`` to a JSON
    file; ``can_spend(cost, now)`` is False once the month's spend would exceed
    the cap. Rolls over automatically when the month changes.

    Pure/injectable: pass ``now`` (unix seconds) and a ``path``; no network.
    A cap ≤ 0 disables the guard (unlimited).
    """

    def __init__(self, path: str, monthly_budget: float, clock=time.time) -> None:
        self.path = path
        self.monthly_budget = float(monthly_budget)
        self._clock = clock
        self._month = ""
        self._spent = 0.0
        self._load()

    @staticmethod
    def _month_key(now: float) -> str:
        t = time.gmtime(now)
        return f"{t.tm_year:04d}-{t.tm_mon:02d}"

    def _load(self) -> None:
        if not self.path or not os.path.exists(self.path):
            return
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self._month = str(data.get("month", ""))
            self._spent = float(data.get("spent", 0.0))
        except (OSError, json.JSONDecodeError, ValueError, TypeError):
            self._month, self._spent = "", 0.0

    def _save(self) -> None:
        if not self.path:
            return
        parent = os.path.dirname(self.path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"month": self._month, "spent": round(self._spent, 6)}, f)
        os.replace(tmp, self.path)

    def _roll(self, now: float) -> None:
        mk = self._month_key(now)
        if mk != self._month:
            self._month = mk
            self._spent = 0.0

    @property
    def enabled(self) -> bool:
        return self.monthly_budget > 0

    def spent(self, now: float | None = None) -> float:
        self._roll(self._clock() if now is None else now)
        return self._spent

    def can_spend(self, cost: float, now: float | None = None) -> bool:
        if not self.enabled:
            return True
        n = self._clock() if now is None else now
        self._roll(n)
        return (self._spent + float(cost)) <= self.monthly_budget

    def record(self, cost: float, now: float | None = None) -> float:
        n = self._clock() if now is None else now
        self._roll(n)
        self._spent += float(cost)
        self._save()
        return self._spent


@dataclass
class DemographyConfig:
    engine: str = DEFAULT_ENGINE
    interval_sec: float = DEFAULT_INTERVAL_SEC
    roi: tuple = ()             # legacy single ROI polygon (normalized) or () = whole frame
    pois: list = field(default_factory=list)  # tagged POIs (NamedPolygon) — per-face gate + name
    ai_prompt: str = ""
    ai_budget_monthly: float = 0.0
    ai_cost_per_image: float = DEFAULT_AI_COST_PER_IMAGE
    ai_model: str = ""

    @classmethod
    def from_dict(cls, config: dict[str, Any] | None) -> "DemographyConfig":
        from ..zones import parse_points, parse_pois

        cfg = config or {}
        engine = str(cfg.get("engine", DEFAULT_ENGINE)).strip().lower()
        if engine not in _ENGINES:
            engine = DEFAULT_ENGINE
        interval = cfg.get("intervalSec")
        interval = float(interval) if isinstance(interval, (int, float)) and interval > 0 else DEFAULT_INTERVAL_SEC
        roi_raw = cfg.get("roi")
        roi_points = ()
        if isinstance(roi_raw, Mapping):
            roi_points = parse_points(roi_raw.get("points"))
        elif isinstance(roi_raw, (list, tuple)):
            roi_points = parse_points(roi_raw)
        budget = cfg.get("aiBudgetMonthly")
        budget = float(budget) if isinstance(budget, (int, float)) and budget > 0 else 0.0
        cost = cfg.get("aiCostPerImage")
        cost = float(cost) if isinstance(cost, (int, float)) and cost > 0 else DEFAULT_AI_COST_PER_IMAGE
        return cls(
            engine=engine,
            interval_sec=interval,
            roi=roi_points,
            pois=parse_pois(cfg),
            ai_prompt=str(cfg.get("aiPrompt", "")).strip(),
            ai_budget_monthly=budget,
            ai_cost_per_image=cost,
            ai_model=str(cfg.get("aiModel", "")).strip(),
        )


def build_face_event(
    record: dict[str, Any],
    engine: str,
    tag: str | None = None,
    poi: str | None = None,
) -> dict[str, Any]:
    """Shape a parsed/derived face record into the ``demography.face`` payload
    specifics (Wave-2 contract). ``poi`` is the name of the POI the face fell in
    (None = whole frame / AI engine); it also defaults ``tag`` when unset so a
    per-POI face is tagged by its region."""
    out = {
        "age": record.get("age"),
        "ageRange": record.get("ageRange"),
        "gender": record.get("gender"),
        "genderConfidence": record.get("genderConfidence"),
        "emotion": record.get("emotion"),
        "emotionConfidence": record.get("emotionConfidence"),
        "engine": engine,
    }
    if poi:
        out["poi"] = poi
    resolved_tag = tag or poi
    if resolved_tag:
        out["tag"] = resolved_tag
    return out


def run(config) -> int:  # pragma: no cover - runtime wiring (needs insightface/net)
    from ..runtime import run_demography

    return run_demography(config)
