"""Event payload builder, HMAC signing + POST (network fully faked)."""
import hashlib
import hmac
import json

from safety_ppe_worker.callback import build_event, post_json, sign_body


def test_build_event_shape():
    ev = build_event("live", "main", "dock", ["vest", "helmet"], 0.87654, "/e/x.jpg", 123.5)
    assert ev == {
        "event": "ppe.violation",
        "app": "live",
        "room": "main",
        "ts": 123.5,
        "zone": "dock",
        "missing": ["helmet", "vest"],  # sorted + deduped
        "confidence": 0.8765,
        "snapshot_path": "/e/x.jpg",
    }


def test_build_event_empty_snapshot():
    assert build_event("a", "r", "z", ["helmet"], 0.5, "", 1.0)["snapshot_path"] == ""


def test_sign_body_matches_core_callbacks_format():
    body = b'{"event":"ppe.violation"}'
    expected = hmac.new(b"secret", body, hashlib.sha256).hexdigest()
    assert sign_body("secret", body) == f"sha256={expected}"


class _FakeResp:
    def __init__(self, status):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_post_json_signs_when_secret_set():
    captured = {}

    def opener(req, timeout):
        captured["body"] = req.data
        captured["sig"] = req.get_header("X-streamhub-signature")
        captured["event"] = req.get_header("X-streamhub-event")
        return _FakeResp(200)

    payload = build_event("live", "main", "dock", ["helmet"], 0.9, "", 1.0)
    status = post_json("https://hooks.test/ppe", payload, secret="s3cret", opener=opener)
    assert status == 200
    assert captured["event"] == "ppe.violation"
    expected = hmac.new(b"s3cret", captured["body"], hashlib.sha256).hexdigest()
    assert captured["sig"] == f"sha256={expected}"
    assert json.loads(captured["body"])["zone"] == "dock"


def test_post_json_omits_signature_and_token_without_secrets():
    captured = {}

    def opener(req, timeout):
        captured["sig"] = req.get_header("X-streamhub-signature")
        captured["token"] = req.get_header("X-plugin-ingest-token")
        return _FakeResp(201)

    assert post_json("https://x.test", {"room": "r"}, opener=opener) == 201
    assert captured["sig"] is None and captured["token"] is None


def test_post_json_sends_ingest_token_when_given():
    captured = {}

    def opener(req, timeout):
        captured["token"] = req.get_header("X-plugin-ingest-token")
        return _FakeResp(200)

    post_json("https://x.test", {"room": "r"}, token="tok-1", opener=opener)
    assert captured["token"] == "tok-1"


def test_post_json_returns_status_on_http_error_and_zero_on_transport_error():
    import urllib.error

    def opener_404(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 404, "nf", None, None)

    assert post_json("https://x.test", {}, opener=opener_404) == 404

    def opener_down(req, timeout):
        raise urllib.error.URLError("refused")

    assert post_json("https://x.test", {}, opener=opener_down) == 0
