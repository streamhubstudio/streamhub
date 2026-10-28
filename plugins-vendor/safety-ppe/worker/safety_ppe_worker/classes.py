"""
Model class → canonical PPE role mapping (pure, unit-tested).

The worker reasons in five canonical ROLES, whatever the underlying model calls
its classes:

    person | helmet | no_helmet | vest | no_vest

The default class list is the exact 14-class order of the shipped model
(Hexmon/vyra-yolo-ppe-detection, Roboflow "PPE Combined Model v4"); a custom
model can override it via SAFETY_PPE_CLASS_NAMES, and at runtime the detector
prefers the `names` dict embedded in the ONNX metadata by the ultralytics
exporter (parsed here, tolerantly) over both.
"""
from __future__ import annotations

import ast
import re

# Shipped model class ids 0–13 (verified against the model card / args.yaml).
DEFAULT_CLASS_NAMES: list[str] = [
    "Fall-Detected",
    "Gloves",
    "Goggles",
    "Hardhat",
    "Ladder",
    "Mask",
    "NO-Gloves",
    "NO-Goggles",
    "NO-Hardhat",
    "NO-Mask",
    "NO-Safety Vest",
    "Person",
    "Safety Cone",
    "Safety Vest",
]

# Canonicalized class name → role. Everything unmapped is ignored (gloves,
# goggles, cones, …) — this plugin only enforces helmet + vest on persons.
_ROLE_BY_CANON: dict[str, str] = {
    "person": "person",
    "hardhat": "helmet",
    "helmet": "helmet",
    "safetyhelmet": "helmet",
    "nohardhat": "no_helmet",
    "nohelmet": "no_helmet",
    "vest": "vest",
    "safetyvest": "vest",
    "novest": "no_vest",
    "nosafetyvest": "no_vest",
}

#: Items this plugin can require/report as missing.
ITEMS: tuple[str, ...] = ("helmet", "vest")


def canon(name: str) -> str:
    """Lowercase + strip every non-alphanumeric: 'NO-Safety Vest' → 'nosafetyvest'."""
    return re.sub(r"[^a-z0-9]", "", str(name).lower())


def role_of(name: str) -> str | None:
    """Canonical role for a raw model class name, or None if irrelevant."""
    return _ROLE_BY_CANON.get(canon(name))


def roles_for(names: list[str]) -> list[str | None]:
    """Per-index role list for a model's class-name list."""
    return [role_of(n) for n in names]


def parse_class_names(raw: str | None) -> list[str] | None:
    """Parse a comma-separated class-name override. Empty/None → None."""
    if not raw or not raw.strip():
        return None
    names = [p.strip() for p in raw.split(",")]
    names = [n for n in names if n]
    return names or None


def parse_names_metadata(raw: str | None) -> list[str] | None:
    """Parse the `names` metadata string an ultralytics ONNX export embeds:
    "{0: 'Fall-Detected', 1: 'Gloves', ...}" → ordered list of names.

    Tolerant: any malformed/partial metadata returns None (caller falls back to
    the configured list) instead of raising.
    """
    if not raw:
        return None
    try:
        obj = ast.literal_eval(raw)
    except (ValueError, SyntaxError):
        return None
    if not isinstance(obj, dict) or not obj:
        return None
    try:
        items = sorted(((int(k), str(v)) for k, v in obj.items()), key=lambda kv: kv[0])
    except (TypeError, ValueError):
        return None
    ids = [k for k, _ in items]
    if ids != list(range(len(ids))):  # must be a dense 0..n-1 id space
        return None
    return [v for _, v in items]
