"""Class-name canonicalization + role mapping + ONNX metadata parsing."""
from safety_ppe_worker.classes import (
    DEFAULT_CLASS_NAMES,
    canon,
    parse_class_names,
    parse_names_metadata,
    role_of,
    roles_for,
)


def test_canon_strips_case_and_punctuation():
    assert canon("NO-Safety Vest") == "nosafetyvest"
    assert canon("Hardhat") == "hardhat"
    assert canon("  Person ") == "person"


def test_role_mapping_for_shipped_model_names():
    assert role_of("Person") == "person"
    assert role_of("Hardhat") == "helmet"
    assert role_of("NO-Hardhat") == "no_helmet"
    assert role_of("Safety Vest") == "vest"
    assert role_of("NO-Safety Vest") == "no_vest"


def test_role_mapping_tolerates_other_datasets_spellings():
    assert role_of("helmet") == "helmet"
    assert role_of("no_helmet") == "no_helmet"
    assert role_of("safety-vest") == "vest"
    assert role_of("NO VEST") == "no_vest"


def test_irrelevant_classes_have_no_role():
    for name in ("Gloves", "Goggles", "Ladder", "Mask", "Safety Cone", "Fall-Detected"):
        assert role_of(name) is None


def test_default_class_list_maps_expected_indices():
    roles = roles_for(DEFAULT_CLASS_NAMES)
    assert roles[3] == "helmet"      # Hardhat
    assert roles[8] == "no_helmet"   # NO-Hardhat
    assert roles[10] == "no_vest"    # NO-Safety Vest
    assert roles[11] == "person"     # Person
    assert roles[13] == "vest"       # Safety Vest
    assert len(DEFAULT_CLASS_NAMES) == 14


def test_parse_class_names_csv_and_empty():
    assert parse_class_names("a, b ,c") == ["a", "b", "c"]
    assert parse_class_names("") is None
    assert parse_class_names(None) is None
    assert parse_class_names(" , ") is None


def test_parse_names_metadata_ultralytics_format():
    raw = "{0: 'Person', 1: 'Hardhat', 2: 'Safety Vest'}"
    assert parse_names_metadata(raw) == ["Person", "Hardhat", "Safety Vest"]


def test_parse_names_metadata_rejects_garbage():
    for raw in (None, "", "not a dict", "[1,2]", "{}", "{1: 'a'}", "{0:'a',2:'b'}"):
        assert parse_names_metadata(raw) is None
