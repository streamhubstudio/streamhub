"""Config — worker + edge env parsing, mode detection, JSON tolerance."""
import json

from vision_edge.config import (
    EdgeConfig,
    MultiplexConfig,
    WorkerConfig,
    derive_ws_url,
    detect_mode,
    parse_config_json,
    parse_models,
    parse_tags,
)


def test_worker_config_from_env():
    env = {
        "VISION_MODEL": "counting",
        "VISION_APP": "live",
        "VISION_ROOM": "door",
        "VISION_HLS_URL": "https://x/hls/live/door/index.m3u8",
        "VISION_EVENTS_URL": "https://x/api/v1/apps/live/plugins/vision/events",
        "VISION_INGEST_TOKEN": "tok",
        "VISION_DEVICE": "cuda",
        "VISION_NODE_ID": "edge-1",
        "VISION_TAGS": "store,zoneA",
        "VISION_CONFIG_JSON": '{"lines":[{"id":"l1"}],"fps":3.5}',
    }
    c = WorkerConfig.from_env(env)
    assert c.model == "counting"
    assert c.app == "live" and c.room == "door"
    assert c.device == "cuda"
    assert c.node_id == "edge-1"
    assert c.tags == ["store", "zoneA"]
    assert c.config["fps"] == 3.5


def test_worker_config_defaults_and_validation():
    c = WorkerConfig.from_env({})
    assert c.model == "occupancy"       # unknown/empty → occupancy
    assert c.device == "cpu"
    problems = c.validate()
    assert "VISION_APP is required" in problems
    assert "VISION_ROOM is required" in problems
    assert "VISION_HLS_URL is required" in problems


def test_worker_config_bad_model_and_device_fall_back():
    c = WorkerConfig.from_env({"VISION_MODEL": "nope", "VISION_DEVICE": "tpu"})
    assert c.model == "occupancy"
    assert c.device == "cpu"


def test_worker_config_hls_url_derives_from_public_base():
    # No explicit VISION_HLS_URL → derived from base + app + room (the unified
    # spawn passes VISION_PUBLIC_BASE; trailing slashes tolerated).
    c = WorkerConfig.from_env({
        "VISION_APP": "live", "VISION_ROOM": "door",
        "VISION_PUBLIC_BASE": "https://origin.example/",
    })
    assert c.hls_url == "https://origin.example/hls/live/door/index.m3u8"
    assert c.validate() == []


def test_worker_config_explicit_hls_url_wins_over_public_base():
    c = WorkerConfig.from_env({
        "VISION_APP": "live", "VISION_ROOM": "door",
        "VISION_PUBLIC_BASE": "https://origin.example",
        "VISION_HLS_URL": "https://cdn.example/special.m3u8",
    })
    assert c.hls_url == "https://cdn.example/special.m3u8"


def test_worker_config_no_base_no_url_still_flags_missing():
    c = WorkerConfig.from_env({"VISION_APP": "live", "VISION_ROOM": "door"})
    assert "VISION_HLS_URL is required" in c.validate()


def test_worker_config_prefers_streamhub_event_channel():
    # Edge assignments (and the local worker-hook) inject STREAMHUB_* — those
    # win over the legacy VISION_* when both are present.
    c = WorkerConfig.from_env({
        "STREAMHUB_EVENTS_URL": "http://127.0.0.1:3020/api/v1/apps/live/plugins/occupancy/events",
        "STREAMHUB_INGEST_TOKEN": "scoped-hmac",
        "VISION_EVENTS_URL": "http://legacy/events",
        "VISION_INGEST_TOKEN": "legacy-tok",
    })
    assert c.events_url.endswith("/plugins/occupancy/events")
    assert c.ingest_token == "scoped-hmac"


def test_worker_config_falls_back_to_legacy_vision_event_env():
    # A directly-spawned worker with only the legacy VISION_* still delivers.
    c = WorkerConfig.from_env({
        "VISION_EVENTS_URL": "http://legacy/events",
        "VISION_INGEST_TOKEN": "legacy-tok",
    })
    assert c.events_url == "http://legacy/events"
    assert c.ingest_token == "legacy-tok"


def test_worker_config_engine_and_model_dir():
    c = WorkerConfig.from_env({"VISION_ENGINE": "OpenAI", "VISION_MODEL_DIR": "/cache/vision"})
    assert c.engine == "openai"          # lowercased
    assert c.model_dir == "/cache/vision"
    # Default engine is local when unset.
    assert WorkerConfig.from_env({}).engine == "local"


def test_worker_base_payload():
    c = WorkerConfig.from_env({"VISION_APP": "a", "VISION_ROOM": "r", "VISION_MODEL": "crowd", "VISION_NODE_ID": "n1", "VISION_TAGS": "t1"})
    p = c.base_payload()
    assert p == {"app": "a", "room": "r", "tags": ["t1"], "nodeId": "n1", "model": "crowd"}


def test_parse_config_json_tolerant():
    assert parse_config_json(None) == {}
    assert parse_config_json("") == {}
    assert parse_config_json("not json") == {}
    assert parse_config_json("[1,2,3]") == {}   # non-object
    assert parse_config_json('{"a":1}') == {"a": 1}


def test_parse_tags_json_and_csv():
    assert parse_tags('["a","b"]') == ["a", "b"]
    assert parse_tags("a, b ,c") == ["a", "b", "c"]
    assert parse_tags("") == []
    assert parse_tags(None) == []


def test_edge_config_from_env():
    env = {
        "STREAMHUB_EDGE_WS_URL": "wss://host/api/v1/edge/ws",
        "STREAMHUB_CLUSTER_TOKEN": "sekret",
        "STREAMHUB_NODE_ID": "edge-7",
        "VISION_EDGE_ALLOW_REBOOT": "true",
        "VISION_EDGE_CAPABILITIES": "vision,yolo,lpr",
    }
    c = EdgeConfig.from_env(env)
    assert c.ws_url.endswith("/edge/ws")
    assert c.cluster_token == "sekret"
    assert c.node_id == "edge-7"
    assert c.allow_reboot is True
    assert c.capabilities == ["vision", "yolo", "lpr"]
    assert c.validate() == []


def test_edge_config_defaults_and_validation():
    c = EdgeConfig.from_env({})
    assert c.allow_reboot is False
    assert c.capabilities == ["vision", "yolo"]  # default caps
    assert c.ws_idle_timeout == 30.0             # half-open guard: 2× the 15s ping
    problems = c.validate()
    assert len(problems) == 3


def test_edge_config_ws_idle_timeout_override():
    c = EdgeConfig.from_env({"VISION_EDGE_WS_IDLE_TIMEOUT": "45"})
    assert c.ws_idle_timeout == 45.0
    # Bad value falls back to the default rather than crashing startup.
    assert EdgeConfig.from_env({"VISION_EDGE_WS_IDLE_TIMEOUT": "nope"}).ws_idle_timeout == 30.0


def test_edge_config_derives_ws_url_from_master():
    # The installer's edge.env sets STREAMHUB_MASTER_URL, not the WS URL.
    c = EdgeConfig.from_env({
        "STREAMHUB_MASTER_URL": "https://stream.example.com",
        "STREAMHUB_CLUSTER_TOKEN": "t",
        "STREAMHUB_NODE_ID": "n",
    })
    assert c.ws_url == "wss://stream.example.com/api/v1/edge/ws"


def test_derive_ws_url_variants():
    assert derive_ws_url({"STREAMHUB_EDGE_WS_URL": "wss://x/edge/ws"}) == "wss://x/edge/ws"
    assert derive_ws_url({"STREAMHUB_MASTER_URL": "http://1.2.3.4:3020"}) == "ws://1.2.3.4:3020/api/v1/edge/ws"
    assert derive_ws_url({"STREAMHUB_MASTER_URL": "https://h/api/v1/edge/ws"}) == "wss://h/api/v1/edge/ws"
    assert derive_ws_url({}) == ""


def test_detect_mode():
    assert detect_mode({"STREAMHUB_EDGE_WS_URL": "wss://x"}) == "edge"
    assert detect_mode({"STREAMHUB_MASTER_URL": "https://x"}) == "edge"
    assert detect_mode({}) == "worker"


# --- shared capture (owner item 33) -----------------------------------------

def test_parse_models_filters_unknown_and_dedupes():
    assert parse_models("occupancy, counting ,occupancy") == ["occupancy", "counting"]
    assert parse_models('["crowd","segmentation","demography"]') == ["crowd", "demography"]
    assert parse_models("") == []
    assert parse_models(None) == []


def _mux_env(**over):
    base = {
        "VISION_MODELS": "occupancy,counting,crowd",
        "VISION_APP": "live",
        "VISION_ROOM": "door",
        "VISION_HLS_URL": "https://x/hls/live/door/index.m3u8",
        "VISION_DEVICE": "cuda",
        "VISION_MODEL_DIR": "/cache/vision",
        "VISION_DECODE_FPS": "5",
        "VISION_MULTIPLEX_JSON": json.dumps({
            "occupancy": {
                "config": {"zones": [{"id": "z1"}]},
                "eventsUrl": "https://x/api/v1/apps/live/plugins/occupancy/events",
                "ingestToken": "tok-occ",
                "app": "live",
            },
            "counting": {
                "config": {"lines": [{"id": "l1"}], "fps": 4.0},
                "eventsUrl": "https://x/api/v1/apps/live/plugins/counting/events",
                "ingestToken": "tok-cnt",
            },
        }),
    }
    base.update(over)
    return base


def test_multiplex_config_parses_models_specs_and_cap():
    mux = MultiplexConfig.from_env(_mux_env())
    assert mux.models == ["occupancy", "counting", "crowd"]
    assert mux.decode_fps == 5.0
    assert mux.validate() == []
    # Per-model delivery target + config resolve independently.
    occ = mux.for_model("occupancy")
    assert occ.model == "occupancy"
    assert occ.events_url.endswith("/plugins/occupancy/events")
    assert occ.ingest_token == "tok-occ"
    assert occ.config == {"zones": [{"id": "z1"}]}
    # Shared context (room / hls / device / model_dir) is common to all.
    assert occ.room == "door" and occ.device == "cuda"
    assert occ.hls_url.endswith("/hls/live/door/index.m3u8")
    assert occ.model_dir == "/cache/vision"
    cnt = mux.for_model("counting")
    assert cnt.ingest_token == "tok-cnt" and cnt.config["fps"] == 4.0


def test_multiplex_missing_spec_falls_back_to_base_env():
    # 'crowd' has no slot in VISION_MULTIPLEX_JSON → empty config + base target.
    env = _mux_env()
    env["STREAMHUB_EVENTS_URL"] = "https://x/api/v1/apps/live/plugins/crowd/events"
    env["STREAMHUB_INGEST_TOKEN"] = "base-tok"
    mux = MultiplexConfig.from_env(env)
    crowd = mux.for_model("crowd")
    assert crowd.config == {}
    assert crowd.events_url.endswith("/plugins/crowd/events")
    assert crowd.ingest_token == "base-tok"


def test_multiplex_folds_explicit_single_model_but_not_the_default():
    # An explicit VISION_MODEL joins the set...
    mux = MultiplexConfig.from_env({
        "VISION_MODELS": "counting",
        "VISION_MODEL": "occupancy",
        "VISION_APP": "live", "VISION_ROOM": "r", "VISION_HLS_URL": "h",
    })
    assert mux.models == ["occupancy", "counting"]
    # ...but the WorkerConfig default (occupancy when unset) does NOT sneak in.
    only = MultiplexConfig.from_env({
        "VISION_MODELS": "counting,crowd",
        "VISION_APP": "live", "VISION_ROOM": "r", "VISION_HLS_URL": "h",
    })
    assert only.models == ["counting", "crowd"]


def test_multiplex_validate_requires_a_model():
    mux = MultiplexConfig.from_env({"VISION_APP": "a", "VISION_ROOM": "r", "VISION_HLS_URL": "h"})
    assert any("at least one known model" in p for p in mux.validate())
