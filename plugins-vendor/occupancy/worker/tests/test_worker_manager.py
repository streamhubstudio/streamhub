"""Worker-manager (co-located mono-node mode) — pure-logic tests.

Post-split contract: ONE manager = one app = one model (``--model``); per-room
settings come from the app's per-model db ``<data_dir>/<model>.db`` (table
``stream_settings(room, config_json)`` — no model column), which the core owns.
"""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile

from vision_edge.worker_manager import (
    WorkerManagerConfig,
    child_key,
    discover_rooms,
    read_stream_settings,
    reconcile_plan,
    synthetic_assignment,
)


def _cfg(**over):
    base = dict(
        app="live",
        model="occupancy",
        hls_dir="/data/apps/live/hls",
        data_dir="/data/apps/live/occupancy",
        device="cuda",
        fps=3.5,
        engine="local",
        ai_api_key="",
        model_dir="/data/apps/live/models/vision",
        public_base="https://sh.example.com",
        events_url="http://127.0.0.1:3020/api/v1/apps/live/plugins/occupancy/events",
        ingest_token="tok",
        python_bin="python3",
    )
    base.update(over)
    return WorkerManagerConfig(**base)


class TestConfig:
    def test_from_env_reads_model_and_injected_ingest(self):
        env = {
            "VISION_APP": "live",
            "VISION_MODEL": "counting",
            "VISION_HLS_DIR": "/d/hls",
            "VISION_DATA_DIR": "/d/counting",
            "VISION_DEVICE": "cuda",
            "VISION_MODEL_DIR": "/d/models/vision",
            "STREAMHUB_EVENTS_URL": "http://x/events",
            "STREAMHUB_INGEST_TOKEN": "abc",
        }
        c = WorkerManagerConfig.from_env(env)
        assert c.app == "live"
        assert c.model == "counting"
        assert c.device == "cuda"
        assert c.model_dir == "/d/models/vision"
        assert c.events_url == "http://x/events"
        assert c.ingest_token == "abc"

    def test_validate_requires_app_model_and_source(self):
        assert WorkerManagerConfig.from_env({}).validate()  # all missing
        ok = _cfg()
        assert ok.validate() == []

    def test_validate_requires_model(self):
        problems = _cfg(model="").validate()
        assert any("VISION_MODEL" in p for p in problems)

    def test_validate_rejects_unknown_model(self):
        problems = _cfg(model="segmentation").validate()
        assert any("unknown model: segmentation" in p for p in problems)

    def test_hls_url_prefers_disk_then_public(self):
        assert _cfg().hls_url_for("cam1") == "/data/apps/live/hls/cam1/index.m3u8"
        assert (
            _cfg(hls_dir="").hls_url_for("cam1")
            == "https://sh.example.com/hls/live/cam1/index.m3u8"
        )

    def test_db_path_is_per_model(self):
        # VISION_DATA_DIR = <appDir>/<model> → db is <data_dir>/<model>.db.
        assert _cfg().db_path() == "/data/apps/live/occupancy/occupancy.db"
        assert _cfg(model="crowd", data_dir="/d/crowd").db_path() == "/d/crowd/crowd.db"
        assert _cfg(data_dir="").db_path() == ""


class TestDiscoverRooms:
    def test_only_fresh_playlists_count(self):
        now = 1000.0
        rooms = discover_rooms(
            "/hls",
            now,
            fresh_seconds=30,
            lister=lambda d: ["cam1", "cam2", "cam3"],
            mtime=lambda p: {
                "/hls/cam1/index.m3u8": 990.0,   # 10s old → fresh
                "/hls/cam2/index.m3u8": 900.0,   # 100s old → stale
                "/hls/cam3/index.m3u8": 1000.0,  # now → fresh
            }[p],
        )
        assert rooms == ["cam1", "cam3"]

    def test_missing_playlist_skipped(self):
        def mt(p):
            raise OSError("no such file")

        assert discover_rooms("/hls", 1.0, lister=lambda d: ["x"], mtime=mt) == []

    def test_empty_dir_config_returns_empty(self):
        assert discover_rooms("", 1.0) == []


class TestReadSettings:
    class _FakeConn:
        def __init__(self, row):
            self._row = row

        def execute(self, sql, params):
            # The query is scoped to the room only (db is per-model already).
            assert "model" not in sql.lower()
            assert params == ("cam1",)
            outer = self

            class Cur:
                def fetchone(self):
                    return outer._row

            return Cur()

        def close(self):
            pass

    def test_reads_config_json_row(self):
        cfg_json = json.dumps({"zones": [{"id": "z1", "tag": "door"}]})
        got = read_stream_settings(
            "/d/occupancy.db", "cam1",
            connect=lambda p: self._FakeConn((cfg_json,)),
        )
        assert got["zones"][0]["tag"] == "door"

    def test_missing_row_yields_empty(self):
        assert read_stream_settings(
            "/d/occupancy.db", "cam1",
            connect=lambda p: self._FakeConn(None),
        ) == {}

    def test_db_error_yields_empty(self):
        def boom(p):
            raise RuntimeError("locked")

        assert read_stream_settings("/d/occupancy.db", "cam1", connect=boom) == {}

    def test_no_db_path_yields_empty(self):
        assert read_stream_settings("", "cam1") == {}

    def test_reads_from_real_sqlite_file_readonly(self):
        # End-to-end against a real on-disk db with the core-owned schema
        # (room PK, config_json, updated_at) — the runtime opens it read-only.
        with tempfile.TemporaryDirectory() as d:
            db = os.path.join(d, "occupancy.db")
            conn = sqlite3.connect(db)
            conn.execute(
                "CREATE TABLE stream_settings ("
                "room TEXT PRIMARY KEY, config_json TEXT, updated_at TEXT)"
            )
            conn.execute(
                "INSERT INTO stream_settings VALUES (?,?,?)",
                ("cam1", json.dumps({"zones": [{"id": "z1"}]}), "2026-07-11"),
            )
            conn.commit()
            conn.close()

            got = read_stream_settings(db, "cam1")
            assert got == {"zones": [{"id": "z1"}]}
            # A room with no row → empty (worker starts on defaults).
            assert read_stream_settings(db, "nope") == {}


class TestSyntheticAssignment:
    def test_builds_worker_spawn_with_room_and_config(self):
        a = synthetic_assignment(_cfg(), "cam1", {"zones": []})
        assert a["id"] == "cam1::occupancy"
        assert a["streamId"] == "cam1"
        assert a["model"] == "occupancy"
        assert a["spawn"]["args"] == [
            "-m", "vision_edge", "--mode", "worker",
            "--model", "occupancy", "--app", "live", "--room", "cam1",
        ]
        env = a["spawn"]["env"]
        assert env["VISION_ROOM"] == "cam1"
        assert env["VISION_MODEL"] == "occupancy"
        assert env["VISION_HLS_URL"] == "/data/apps/live/hls/cam1/index.m3u8"
        assert env["VISION_INGEST_TOKEN"] == "tok"
        assert env["VISION_MODEL_DIR"] == "/data/apps/live/models/vision"
        assert env["VISION_DB"] == "/data/apps/live/occupancy/occupancy.db"
        assert json.loads(env["VISION_CONFIG_JSON"]) == {"zones": []}

    def test_model_dir_omitted_when_unset(self):
        env = synthetic_assignment(_cfg(model_dir=""), "cam1", {})["spawn"]["env"]
        assert "VISION_MODEL_DIR" not in env

    def test_ai_key_only_on_demography(self):
        occ = synthetic_assignment(
            _cfg(model="occupancy", ai_api_key="sk-secret"), "cam1", {}
        )
        dem = synthetic_assignment(
            _cfg(model="demography", data_dir="/d/demography", ai_api_key="sk-secret"),
            "cam1", {},
        )
        assert "VISION_AI_API_KEY" not in occ["spawn"]["env"]
        assert dem["spawn"]["env"]["VISION_AI_API_KEY"] == "sk-secret"


class TestReconcilePlan:
    def test_add_and_remove_diff(self):
        add, remove = reconcile_plan(
            desired=["cam1::occupancy", "cam2::occupancy"],
            current=["cam2::occupancy", "cam3::occupancy"],
        )
        assert add == ["cam1::occupancy"]
        assert remove == ["cam3::occupancy"]

    def test_stable_when_equal(self):
        keys = [child_key("a", "occupancy"), child_key("b", "occupancy")]
        assert reconcile_plan(keys, keys) == ([], [])
