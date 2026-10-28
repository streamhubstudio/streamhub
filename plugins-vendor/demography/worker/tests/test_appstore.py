"""
App-versioning bundle cache (edge side) — pure fetch/verify/extract/redirect
logic. The network downloader is a seam; bundles are built in-memory with
stdlib tarfile, so nothing here touches a socket or torch.
"""
import io
import os
import tarfile

import pytest

from vision_edge.appstore import (
    CLUSTER_TOKEN_HEADER,
    MARKER_NAME,
    BundleError,
    BundleRef,
    appstore_base_dir,
    cache_valid,
    download_bundle,
    ensure_bundle,
    extract_tar_gz,
    extracted_root,
    marker_path,
    parse_bundle_ref,
    prepare_assignment_spawn,
    redirect_worker_dir,
    sha256_hex,
    worker_dir,
)

# The TS spawn-redirect fixtures, ported (spawn-redirect.util.spec.ts).
FROM = os.path.join(os.sep, "repo", "lpr-worker")
TO = os.path.join(os.sep, "data", "appstore", "lpr", "2.9.0", "extracted", "lpr", "worker")


# -- helpers ----------------------------------------------------------------

def _make_bundle(plugin_id: str, files: dict[str, bytes | str]) -> bytes:
    """A gzipped USTAR bundle laid out ``<plugin_id>/worker/<rel>`` — the shape
    the master's exporter produces."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for rel, content in files.items():
            data = content if isinstance(content, bytes) else content.encode()
            info = tarfile.TarInfo(name=f"{plugin_id}/worker/{rel}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def _ref_for(plugin_id: str, version: str, gz: bytes) -> BundleRef:
    return BundleRef(plugin_id, version, sha256_hex(gz), f"https://master/api/v1/plugins/{plugin_id}/versions/{version}/bundle")


# -- parse_bundle_ref -------------------------------------------------------

def test_parse_bundle_ref_present():
    a = {
        "id": "cam1::lpr",
        "spawn": {"command": "python3"},
        "bundle": {
            "pluginId": "lpr",
            "version": "2.9.0",
            "sha256": "ABCDEF01",
            "url": "https://master/api/v1/plugins/lpr/versions/2.9.0/bundle",
        },
    }
    ref = parse_bundle_ref(a)
    assert ref == BundleRef("lpr", "2.9.0", "abcdef01", "https://master/api/v1/plugins/lpr/versions/2.9.0/bundle")


def test_parse_bundle_ref_absent_is_none():
    assert parse_bundle_ref({"id": "a1", "spawn": {}}) is None
    assert parse_bundle_ref({"id": "a1"}) is None
    assert parse_bundle_ref(None) is None
    assert parse_bundle_ref("nope") is None


def test_parse_bundle_ref_malformed_is_none():
    base = {"pluginId": "lpr", "version": "2.9.0", "sha256": "aa", "url": "u"}
    assert parse_bundle_ref({"bundle": []}) is None            # not a dict
    for missing in ("pluginId", "version", "sha256", "url"):
        bad = dict(base)
        del bad[missing]
        assert parse_bundle_ref({"bundle": bad}) is None       # missing field
        blank = dict(base)
        blank[missing] = "  "
        assert parse_bundle_ref({"bundle": blank}) is None     # blank field
        typed = dict(base)
        typed[missing] = 123
        assert parse_bundle_ref({"bundle": typed}) is None     # non-string field


# -- redirect_worker_dir (ports spawn-redirect.util.spec.ts) ----------------

def test_redirect_swaps_prefix_in_cwd_pythonpath_and_args():
    spec = {
        "command": "python3",
        "args": ["-m", "lpr_worker", "--src", FROM],
        "cwd": FROM,
        "env": {"PYTHONPATH": FROM, "LPR_APP": "live", "OTHER": "/unrelated/path"},
    }
    out = redirect_worker_dir(spec, TO, from_dir=FROM)
    assert out["cwd"] == TO
    assert out["env"]["PYTHONPATH"] == TO
    assert out["args"] == ["-m", "lpr_worker", "--src", TO]
    # Non-matching values are preserved verbatim.
    assert out["env"]["LPR_APP"] == "live"
    assert out["env"]["OTHER"] == "/unrelated/path"
    assert out["command"] == "python3"


def test_redirect_rewrites_subpaths():
    sub = os.path.join(FROM, "models", "weights")
    out = redirect_worker_dir({"command": "x", "env": {"W": sub}, "cwd": FROM}, TO, from_dir=FROM)
    assert out["env"]["W"] == os.path.join(TO, "models", "weights")


def test_redirect_does_not_match_sibling_prefix():
    sibling = FROM + "-extra"
    out = redirect_worker_dir({"command": "x", "env": {"S": sibling}}, TO, from_dir=FROM)
    # `<FROM>-extra` is NOT under `<FROM>/` → left alone.
    assert out["env"]["S"] == sibling


def test_redirect_derives_from_dir_from_pythonpath():
    # An edge frame drops the master's cwd; PYTHONPATH carries the built-in dir,
    # so with no explicit from_dir the swap still finds it.
    spec = {"command": "python3", "args": ["-m", "vision_edge", "--src", FROM], "env": {"PYTHONPATH": FROM}}
    out = redirect_worker_dir(spec, TO)
    assert out["cwd"] == TO
    assert out["env"]["PYTHONPATH"] == TO
    assert out["args"] == ["-m", "vision_edge", "--src", TO]


def test_redirect_forces_cwd_and_pythonpath_when_frame_had_no_dir():
    # A frame carrying neither cwd nor PYTHONPATH still runs from the pinned dir
    # (so `python -m <module>` imports the pinned bundle).
    out = redirect_worker_dir({"command": "python3", "args": ["-m", "vision_edge"], "env": {}}, TO)
    assert out["cwd"] == TO
    assert out["env"]["PYTHONPATH"] == TO
    assert out["args"] == ["-m", "vision_edge"]


# -- download_bundle (token header) -----------------------------------------

def test_download_bundle_sends_cluster_token_header():
    seen = {}

    def opener(url, headers):
        seen["url"] = url
        seen["headers"] = headers
        return b"payload"

    out = download_bundle("https://master/bundle", "tok-123", opener=opener)
    assert out == b"payload"
    assert seen["url"] == "https://master/bundle"
    assert seen["headers"][CLUSTER_TOKEN_HEADER] == "tok-123"


# -- extract_tar_gz ---------------------------------------------------------

def test_extract_tar_gz_writes_files(tmp_path):
    gz = _make_bundle("lpr", {"lpr_worker/__init__.py": "# lpr\n", "lpr_worker/main.py": "print(1)\n"})
    dest = str(tmp_path / "extracted")
    written = extract_tar_gz(gz, dest)
    assert written == 2
    assert (tmp_path / "extracted" / "lpr" / "worker" / "lpr_worker" / "__init__.py").read_text() == "# lpr\n"


def test_extract_tar_gz_refuses_traversal(tmp_path):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        data = b"pwn"
        info = tarfile.TarInfo(name="../evil.txt")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    with pytest.raises(BundleError):
        extract_tar_gz(buf.getvalue(), str(tmp_path / "extracted"))
    assert not (tmp_path / "evil.txt").exists()


# -- appstore_base_dir ------------------------------------------------------

def test_appstore_base_dir_env_and_default():
    assert appstore_base_dir({"VISION_EDGE_APPSTORE_DIR": "/srv/cache"}) == "/srv/cache"
    default = appstore_base_dir({})
    assert default.endswith(os.path.join(".streamhub", "appstore"))
    assert "~" not in default  # expanded


# -- ensure_bundle ----------------------------------------------------------

def test_ensure_bundle_downloads_verifies_extracts(tmp_path):
    base = str(tmp_path)
    gz = _make_bundle("lpr", {"lpr_worker/__init__.py": "# lpr\n"})
    ref = _ref_for("lpr", "2.9.0", gz)
    calls = []

    def download(url):
        calls.append(url)
        return gz

    wd = ensure_bundle(ref, base, download)
    assert wd == worker_dir(base, "lpr", "2.9.0")
    assert os.path.isfile(os.path.join(wd, "lpr_worker", "__init__.py"))
    # Marker recorded and matches → the cache is trusted next time.
    assert os.path.isfile(marker_path(base, "lpr", "2.9.0"))
    assert calls == [ref.url]
    # Atomic extract leaves no temp dirs behind.
    leftovers = [n for n in os.listdir(os.path.join(base, "lpr", "2.9.0")) if n.startswith("extracted.tmp-")]
    assert leftovers == []


def test_ensure_bundle_cache_hit_skips_download(tmp_path):
    base = str(tmp_path)
    gz = _make_bundle("lpr", {"lpr_worker/__init__.py": "# lpr\n"})
    ref = _ref_for("lpr", "2.9.0", gz)
    # Prime the cache once.
    ensure_bundle(ref, base, lambda url: gz)
    assert cache_valid(base, ref)
    # Second call must not download.
    def must_not_download(url):
        raise AssertionError("download should not be called on a cache hit")

    assert ensure_bundle(ref, base, must_not_download) == worker_dir(base, "lpr", "2.9.0")


def test_ensure_bundle_sha256_mismatch_fails_without_extract(tmp_path):
    base = str(tmp_path)
    gz = _make_bundle("lpr", {"lpr_worker/__init__.py": "# lpr\n"})
    ref = BundleRef("lpr", "2.9.0", "deadbeef" * 8, "https://master/bundle")  # wrong sha
    calls = []

    def download(url):
        calls.append(url)
        return gz

    with pytest.raises(BundleError) as exc:
        ensure_bundle(ref, base, download)
    assert "sha256 mismatch" in str(exc.value)
    assert calls == ["https://master/bundle"]
    # Nothing extracted, no marker.
    assert not os.path.isdir(worker_dir(base, "lpr", "2.9.0"))
    assert not os.path.exists(extracted_root(base, "lpr", "2.9.0"))


def test_ensure_bundle_corrupt_cache_redownloads_once(tmp_path):
    base = str(tmp_path)
    gz = _make_bundle("lpr", {"lpr_worker/__init__.py": "# lpr\n"})
    ref = _ref_for("lpr", "2.9.0", gz)
    # A worker dir with NO marker (a crash mid-extract) is not trusted.
    er = extracted_root(base, "lpr", "2.9.0")
    os.makedirs(os.path.join(er, "lpr", "worker"), exist_ok=True)
    assert not cache_valid(base, ref)
    calls = []

    def download(url):
        calls.append(url)
        return gz

    wd = ensure_bundle(ref, base, download)
    assert calls == [ref.url]  # re-downloaded exactly once
    assert os.path.isfile(marker_path(base, "lpr", "2.9.0"))
    assert os.path.isfile(os.path.join(wd, "lpr_worker", "__init__.py"))


def test_ensure_bundle_concurrent_lock_waits_then_uses_peer_cache(tmp_path):
    base = str(tmp_path)
    gz = _make_bundle("lpr", {"lpr_worker/__init__.py": "# lpr\n"})
    ref = _ref_for("lpr", "2.9.0", gz)
    vdir = os.path.join(base, "lpr", "2.9.0")
    os.makedirs(vdir, exist_ok=True)
    # Simulate a peer holding the lock.
    lock_path = os.path.join(vdir, ".lock")
    peer_fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    os.close(peer_fd)

    def peer_finishes(_delay):
        # The peer completes: seed a valid cache, then release the lock.
        extract_tar_gz(gz, extracted_root(base, "lpr", "2.9.0"))
        with open(marker_path(base, "lpr", "2.9.0"), "w") as f:
            f.write(ref.sha256.lower())
        os.unlink(lock_path)

    calls = []

    def download(url):
        calls.append(url)
        return gz

    wd = ensure_bundle(ref, base, download, sleep=peer_finishes, clock=lambda: 0.0)
    assert wd == worker_dir(base, "lpr", "2.9.0")
    assert calls == []  # peer already extracted it — no second download


# -- prepare_assignment_spawn -----------------------------------------------

def test_prepare_no_bundle_returns_unchanged():
    a = {"id": "a1", "spawn": {"command": "python3", "args": ["-m", "vision_edge"], "env": {}}}
    out = prepare_assignment_spawn(a, "/unused", lambda url: b"")
    assert out is a  # untouched (no fetch, no copy)


def test_prepare_with_bundle_rewrites_spawn(tmp_path):
    base = str(tmp_path)
    gz = _make_bundle("lpr", {"lpr_worker/__init__.py": "# lpr\n"})
    ref = _ref_for("lpr", "2.9.0", gz)
    builtin = os.path.join(os.sep, "master", "lpr-worker")
    a = {
        "id": "cam1::lpr",
        "spawn": {
            "command": "python3",
            "args": ["-m", "lpr_worker", "--src", builtin],
            "env": {"PYTHONPATH": builtin, "LPR_APP": "live"},
        },
        "bundle": {"pluginId": "lpr", "version": "2.9.0", "sha256": ref.sha256, "url": ref.url},
    }
    out = prepare_assignment_spawn(a, base, lambda url: gz)
    wd = worker_dir(base, "lpr", "2.9.0")
    assert out is not a  # a copy
    assert out["spawn"]["cwd"] == wd
    assert out["spawn"]["env"]["PYTHONPATH"] == wd
    assert out["spawn"]["args"] == ["-m", "lpr_worker", "--src", wd]
    assert out["spawn"]["env"]["LPR_APP"] == "live"  # unrelated env preserved


def test_prepare_sha_mismatch_propagates(tmp_path):
    gz = _make_bundle("lpr", {"lpr_worker/__init__.py": "# lpr\n"})
    a = {
        "id": "cam1::lpr",
        "spawn": {"command": "python3"},
        "bundle": {"pluginId": "lpr", "version": "2.9.0", "sha256": "00" * 32, "url": "https://master/bundle"},
    }
    with pytest.raises(BundleError):
        prepare_assignment_spawn(a, str(tmp_path), lambda url: gz)
