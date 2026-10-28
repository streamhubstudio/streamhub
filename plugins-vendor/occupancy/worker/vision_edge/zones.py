"""
Polygon zones — pure parsing + membership + class filtering (no cv2/numpy).

Wave-2 occupancy/crowd config schema (config_json per model):
    {"zones": [{"id", "tag", "detect": "personas"|"vehiculos",
                "points": [[x,y]…normalized 0-1],
                "confidence"?, "alertLimit"?, "alertAfterSec"?}]}

A detection "occupies" a zone when its ANCHOR point (bbox foot by default —
Vision One used the centroid; foot is steadier for CCTV persons) is inside the
polygon AND its class matches the zone's ``detect`` kind AND its confidence
clears the zone threshold. One detection can occupy several overlapping zones.

The COCO class groups mirror Vision One's occupancy ``_calculate_class_ids``:
personas → {person}; vehiculos → {car, truck, bus, motorcycle}.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

from .geometry import Point, bbox_anchor, point_in_polygon

# Vision One occupancy COCO groups (occupancy/streaming._calculate_class_ids).
PERSON_CLASSES = frozenset({"person"})
VEHICLE_CLASSES = frozenset({"car", "truck", "bus", "motorcycle"})
# COCO ids ultralytics filters on (classes= argument to model.track).
PERSON_CLASS_IDS = (0,)
VEHICLE_CLASS_IDS = (2, 7, 5, 3)  # car, truck, bus, motorcycle

DEFAULT_CONFIDENCE = 0.30
_KINDS = ("personas", "vehiculos")


def _f(value: Any) -> float | None:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):  # NaN / inf guard
        return None
    return f


def clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


@dataclass(frozen=True)
class PolygonZone:
    id: str
    tag: str
    detect: str  # 'personas' | 'vehiculos'
    points: tuple[Point, ...]
    confidence: float = DEFAULT_CONFIDENCE
    alert_limit: int = 0        # occupancy count that trips occupancy.alert (0 = off)
    alert_after_sec: float = 0.0  # sustained seconds before the alert fires

    @property
    def classes(self) -> frozenset[str]:
        return PERSON_CLASSES if self.detect == "personas" else VEHICLE_CLASSES

    @property
    def class_ids(self) -> tuple[int, ...]:
        return PERSON_CLASS_IDS if self.detect == "personas" else VEHICLE_CLASS_IDS

    @property
    def kind(self) -> str:
        """Event ``kind`` field — same token as ``detect`` per the contract."""
        return self.detect

    def contains_anchor(self, bbox: Sequence[float], mode: str = "foot") -> bool:
        px, py = bbox_anchor(bbox, mode)
        return point_in_polygon(px, py, self.points)


def detect_kind_matches(zone: PolygonZone, class_name: str | None) -> bool:
    """Does a detection's COCO class name qualify for the zone's kind?"""
    if not class_name:
        return False
    return class_name.strip().lower() in zone.classes


def parse_points(raw: Any) -> tuple[Point, ...]:
    """Parse a ``points`` list of [x,y] pairs → clamped tuple (0-1).

    Non-list input, or fewer than 3 valid vertices, yields an empty tuple
    (an empty polygon never contains a point, so a malformed zone is inert).
    """
    if not isinstance(raw, (list, tuple)):
        return ()
    out: list[Point] = []
    for pair in raw:
        if not isinstance(pair, (list, tuple)) or len(pair) < 2:
            continue
        x, y = _f(pair[0]), _f(pair[1])
        if x is None or y is None:
            continue
        out.append((clamp01(x), clamp01(y)))
    return tuple(out) if len(out) >= 3 else ()


def parse_zones(config: Any) -> list[PolygonZone]:
    """Parse the ``zones`` config (a dict with a ``zones`` list, or a bare
    list) → validated PolygonZones. Tolerant: bad entries are skipped, not
    raised; duplicate ids keep the first; a zone needs a non-empty id and a
    valid polygon (≥3 points).
    """
    zones_raw: Any
    if isinstance(config, Mapping):
        zones_raw = config.get("zones", [])
    else:
        zones_raw = config
    if not isinstance(zones_raw, (list, tuple)):
        return []

    out: list[PolygonZone] = []
    seen: set[str] = set()
    for item in zones_raw:
        if not isinstance(item, Mapping):
            continue
        zid = item.get("id")
        if not isinstance(zid, str) or not zid.strip():
            continue
        zid = zid.strip()
        if zid in seen:
            continue
        points = parse_points(item.get("points"))
        if not points:
            continue
        detect = str(item.get("detect", "personas")).strip().lower()
        if detect not in _KINDS:
            detect = "personas"
        tag = item.get("tag")
        tag = tag.strip() if isinstance(tag, str) and tag.strip() else zid
        conf = _f(item.get("confidence"))
        conf = clamp01(conf) if conf is not None else DEFAULT_CONFIDENCE
        limit = _f(item.get("alertLimit"))
        alert_limit = max(0, int(limit)) if limit is not None else 0
        after = _f(item.get("alertAfterSec"))
        alert_after = max(0.0, after) if after is not None else 0.0
        seen.add(zid)
        out.append(
            PolygonZone(
                id=zid,
                tag=tag,
                detect=detect,
                points=points,
                confidence=conf,
                alert_limit=alert_limit,
                alert_after_sec=alert_after,
            )
        )
    return out


# ---------------------------------------------------------------------------
# POIs — generic tagged polygon regions (ANY model: counting / demography / …)
# ---------------------------------------------------------------------------
#
# occupancy + crowd already gate by polygon ZONES (which carry class/alert
# semantics). A POI is the lighter, model-agnostic version — just id + tag +
# polygon — so counting (line crossings) and demography (faces) can restrict a
# detection to inside a named region and stamp every event with that region's
# name, WITHOUT the zone's personas/vehiculos/alert machinery. Empty POIs = whole
# frame (backward compatible).


@dataclass(frozen=True)
class NamedPolygon:
    """A tagged POI polygon (normalized coords). ``name`` is the tag (or the id
    when untagged) — the value stamped onto every event that falls inside it."""

    id: str
    tag: str
    points: tuple[Point, ...]

    @property
    def name(self) -> str:
        return self.tag or self.id

    def contains_anchor(self, bbox: Sequence[float], mode: str = "foot") -> bool:
        px, py = bbox_anchor(bbox, mode)
        return point_in_polygon(px, py, self.points)


def parse_pois(config: Any, key: str = "pois") -> list["NamedPolygon"]:
    """Parse a ``pois`` list (a dict carrying ``key``, or a bare list) →
    validated :class:`NamedPolygon`. Tolerant: bad entries skipped (not raised),
    a POI needs ≥3 valid points, ids auto-fill (``poi1``…) and dedupe; the tag
    defaults to the id."""
    raw: Any
    if isinstance(config, Mapping):
        raw = config.get(key, [])
    else:
        raw = config
    if not isinstance(raw, (list, tuple)):
        return []
    out: list[NamedPolygon] = []
    seen: set[str] = set()
    for i, item in enumerate(raw):
        if not isinstance(item, Mapping):
            continue
        points = parse_points(item.get("points"))
        if not points:
            continue
        pid = item.get("id")
        pid = pid.strip() if isinstance(pid, str) and pid.strip() else f"poi{i}"
        if pid in seen:
            continue
        tag = item.get("tag")
        tag = tag.strip() if isinstance(tag, str) and tag.strip() else pid
        seen.add(pid)
        out.append(NamedPolygon(id=pid, tag=tag, points=points))
    return out


def poi_for_anchor(
    pois: Iterable["NamedPolygon"], bbox: Sequence[float], mode: str = "foot"
) -> "NamedPolygon | None":
    """The FIRST POI whose polygon contains the bbox anchor, else ``None``.

    ``None`` means "outside every POI" — a caller with a non-empty POI list drops
    the detection; a caller with an EMPTY POI list should never call this (empty
    = whole frame = keep everything)."""
    for poi in pois:
        try:
            if poi.contains_anchor(bbox, mode):
                return poi
        except (TypeError, ValueError):
            continue
    return None


def count_in_zone(zone: PolygonZone, detections: Iterable[Any], mode: str = "foot") -> int:
    """Count qualifying detections whose anchor is inside the zone.

    Each detection is a dict ``{"bbox": [x1,y1,x2,y2], "cls": <name>, "conf":
    <float>}`` (bbox normalized). A detection qualifies when its class matches
    the zone kind, its confidence clears the zone threshold, and its anchor is
    inside the polygon.
    """
    n = 0
    for det in detections:
        if not isinstance(det, Mapping):
            continue
        cls = det.get("cls") or det.get("class") or det.get("class_specific")
        if not detect_kind_matches(zone, cls if isinstance(cls, str) else None):
            continue
        conf = _f(det.get("conf") if "conf" in det else det.get("confidence"))
        if conf is not None and conf < zone.confidence:
            continue
        bbox = det.get("bbox")
        if not isinstance(bbox, (list, tuple)) or len(bbox) < 4:
            continue
        try:
            if zone.contains_anchor(bbox, mode):
                n += 1
        except (TypeError, ValueError):
            continue
    return n


def count_all_zones(
    zones: Iterable[PolygonZone], detections: Iterable[Any], mode: str = "foot"
) -> dict[str, int]:
    """Per-zone counts (zone id → qualifying detections inside)."""
    dets = list(detections)
    return {z.id: count_in_zone(z, dets, mode) for z in zones}
