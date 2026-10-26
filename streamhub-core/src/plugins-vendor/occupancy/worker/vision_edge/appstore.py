"""
App-versioning bundle cache — the EDGE side of the appstore contract.

An ``assign`` frame may carry an OPTIONAL ``bundle`` ref pinning an appstore
version (streamhub-core ``edge.types.ts`` ``EdgeBundleRef``):

    bundle: {pluginId, version, sha256, url}

When present, the daemon must — BEFORE spawning the assignment — make the pinned
worker source available locally and run the child from it instead of the edge's
own installed package:

  1. cache-check ``<base>/<pluginId>/<version>/extracted/<pluginId>/worker`` (base
     = ``VISION_EDGE_APPSTORE_DIR`` or ``~/.streamhub/appstore``);
  2. on a miss, DOWNLOAD ``url`` over the cluster gate (``X-Cluster-Token``);
  3. VERIFY sha256 — a mismatch refuses to extract and fails the assignment
     (never crashes the daemon);
  4. EXTRACT atomically (temp dir → rename) and drop a ``.sha256`` marker so a
     half-written / corrupt extract is spotted and re-downloaded once;
  5. REDIRECT the frame's spawn spec onto the extracted worker dir — the python
     mirror of ``spawn-redirect.util.ts`` (swap the built-in dir prefix across
     cwd/args/env; force cwd + PYTHONPATH to the pinned dir).

Absent ``bundle`` → the assignment is spawned exactly as today (an older master
simply omits the field; back-compat). Cache EVICTION is intentionally out of
scope — a re-assign with a new version downloads it and leaves the old one
cached (instant node-local rollback); an operator prunes ``VISION_EDGE_APPSTORE_DIR``.

Everything here is dependency-light stdlib: the network downloader is a SEAM
(injected) so the whole module is unit-tested with no socket, and extraction
operates on in-memory bytes.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from uuid import uuid4

# Cache base default (per-user, NAT-friendly — the node pulls, the master never
# dials in). Overridable via VISION_EDGE_APPSTORE_DIR.
DEFAULT_APPSTORE_DIR = os.path.join("~", ".streamhub", "appstore")
# Marker file inside a version's ``extracted/`` recording the verified digest.
# Its presence (and match) is what makes a cached extract trustworthy.
MARKER_NAME = ".sha256"
# Header the master's bundle endpoint accepts from a node (same NAT-friendly gate
# used for join/heartbeat/WS — see appstore.controller.ts dual-auth).
CLUSTER_TOKEN_HEADER = "X-Cluster-Token"


class BundleError(Exception):
    """A pinned bundle could not be fetched, verified, or extracted. Raised so
    the caller marks the assignment ``failed`` with a clear detail — the daemon
    keeps running."""


@dataclass
class BundleRef:
    """Parsed ``bundle`` ref off an ``assign`` frame (mirrors EdgeBundleRef)."""

    plugin_id: str
    version: str
    sha256: str  # hex, lower-cased for a case-insensitive compare
    url: str


def parse_bundle_ref(assignment: Any) -> BundleRef | None:
    """Extract the optional bundle ref from an assignment dict, or ``None`` when
    it is absent OR malformed (a non-dict, or any required field missing/blank).
    Never raises — a bad ref simply means "no pin", so the caller falls back to
    the built-in spawn rather than failing."""
    if not isinstance(assignment, dict):
        return None
    b = assignment.get("bundle")
    if not isinstance(b, dict):
        return None
    pid = b.get("pluginId")
    ver = b.get("version")
    sha = b.get("sha256")
    url = b.get("url")
    if not all(isinstance(x, str) and x.strip() for x in (pid, ver, sha, url)):
        return None
    return BundleRef(pid.strip(), ver.strip(), sha.strip().lower(), url.strip())


# ---------------------------------------------------------------------------
# Cache layout (mirrors the master's DATA_DIR/appstore/<id>/<v>/extracted/<id>/worker)
# ---------------------------------------------------------------------------

def appstore_base_dir(env: Mapping[str, str] | None = None) -> str:
    """The cache root: ``VISION_EDGE_APPSTORE_DIR`` or ``~/.streamhub/appstore``
    (``~`` expanded)."""
    e = os.environ if env is None else env
    raw = (e.get("VISION_EDGE_APPSTORE_DIR") or "").strip()
    return os.path.expanduser(raw or DEFAULT_APPSTORE_DIR)


def version_dir(base: str, plugin_id: str, version: str) -> str:
    return os.path.join(base, plugin_id, version)


def extracted_root(base: str, plugin_id: str, version: str) -> str:
    return os.path.join(version_dir(base, plugin_id, version), "extracted")


def worker_dir(base: str, plugin_id: str, version: str) -> str:
    """The drop-in equivalent of the built-in worker source dir — the exporter
    packs ``srcDir`` → ``<id>/worker/`` so ``python -m <module>`` resolves here."""
    return os.path.join(extracted_root(base, plugin_id, version), plugin_id, "worker")


def marker_path(base: str, plugin_id: str, version: str) -> str:
    return os.path.join(extracted_root(base, plugin_id, version), MARKER_NAME)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# Spawn redirect — the python mirror of spawn-redirect.util.ts
# ---------------------------------------------------------------------------

def _swap(value: str, from_dir: str, to_dir: str) -> str:
    """Swap a ``from_dir`` prefix for ``to_dir`` in one string (exact match or a
    subpath). A sibling like ``<from_dir>-extra`` is NOT under ``<from_dir>/`` so
    it is left untouched — identical to the TS ``swap``."""
    if value == from_dir:
        return to_dir
    if value.startswith(from_dir + os.sep):
        return to_dir + value[len(from_dir):]
    return value


def redirect_worker_dir(
    spec: Mapping[str, Any],
    to_dir: str,
    from_dir: str | None = None,
) -> dict[str, Any]:
    """Return a COPY of the spawn ``spec`` rewritten to run from the pinned
    extracted dir ``to_dir`` — the python counterpart of ``redirectWorkerDir``.

    ``from_dir`` (the built-in dir the spec references) defaults to the spec's
    ``env['PYTHONPATH']``: an edge ``assign`` frame drops the master's ``cwd``
    (see EdgeSpawnSpec) so PYTHONPATH is the surviving carrier of that dir. Its
    prefix is swapped for ``to_dir`` across every arg + env value. ``cwd`` and
    ``PYTHONPATH`` are then FORCED to ``to_dir`` so the pinned package imports
    even when the frame carried no dir to swap — the one deliberate deviation
    from the TS util, which always has a ``cwd`` to anchor on."""
    env_in = dict(spec.get("env") or {})
    if from_dir is None:
        from_dir = str(env_in.get("PYTHONPATH") or "")
    env: dict[str, str] = {}
    for k, v in env_in.items():
        sv = str(v)
        env[str(k)] = _swap(sv, from_dir, to_dir) if from_dir else sv
    args = [
        (_swap(str(a), from_dir, to_dir) if from_dir else str(a))
        for a in (spec.get("args") or [])
    ]
    env["PYTHONPATH"] = to_dir
    return {
        "command": str(spec.get("command", "")),
        "args": args,
        "env": env,
        "cwd": to_dir,
    }


# ---------------------------------------------------------------------------
# Download (seamed) + tar extraction (pure, stdlib)
# ---------------------------------------------------------------------------

def download_bundle(
    url: str,
    token: str,
    opener: Callable[[str, dict[str, str]], bytes] | None = None,
    timeout: float = 30.0,
) -> bytes:
    """Fetch bundle bytes over the cluster gate, sending the ``X-Cluster-Token``
    header the master's bundle endpoint accepts from a node. ``opener(url,
    headers)`` is injected in tests; the default uses ``urllib``."""
    headers = {CLUSTER_TOKEN_HEADER: token}
    if opener is None:  # pragma: no cover - network
        import urllib.request

        def opener(req_url: str, req_headers: dict[str, str]) -> bytes:
            req = urllib.request.Request(req_url, headers=req_headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()

    return opener(url, headers)


def extract_tar_gz(gz: bytes, dest_dir: str) -> int:
    """Extract a gzipped USTAR bundle under ``dest_dir`` (created if needed),
    returning the number of files written. Mirrors ``tar.util.ts``: only regular
    files + dirs are honored (symlinks/devices skipped — the exporter emits
    none), and any entry whose resolved path escapes ``dest_dir`` (absolute /
    ``..`` traversal) is refused."""
    import io
    import tarfile

    root = os.path.realpath(dest_dir)
    os.makedirs(root, exist_ok=True)
    written = 0
    with tarfile.open(fileobj=io.BytesIO(gz), mode="r:gz") as tar:
        for member in tar.getmembers():
            if not (member.isfile() or member.isdir()):
                continue
            target = os.path.realpath(os.path.join(root, member.name))
            if target != root and not target.startswith(root + os.sep):
                raise BundleError(f"unsafe path in bundle: {member.name}")
            if member.isdir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            src = tar.extractfile(member)
            data = src.read() if src is not None else b""
            with open(target, "wb") as f:
                f.write(data)
            written += 1
    return written


# ---------------------------------------------------------------------------
# Cache get-or-fetch (lock-serialized, sha-verified, atomic extract)
# ---------------------------------------------------------------------------

def cache_valid(base: str, ref: BundleRef) -> bool:
    """True when a COMPLETE, verified extract for ``ref`` is already cached: the
    worker dir exists AND the ``.sha256`` marker matches. A marker that is
    missing (a crash mid-extract) or mismatched reads as invalid → re-download."""
    wd = worker_dir(base, ref.plugin_id, ref.version)
    if not os.path.isdir(wd):
        return False
    try:
        with open(marker_path(base, ref.plugin_id, ref.version), encoding="utf-8") as f:
            return f.read().strip().lower() == ref.sha256.lower()
    except OSError:
        return False


def _acquire_lock(
    vdir: str,
    timeout: float,
    poll: float,
    sleep: Callable[[float], None],
    clock: Callable[[], float],
) -> tuple[str, int]:
    """Acquire a per-version lock (O_CREAT|O_EXCL marker file) so concurrent
    assignments for the SAME bundle don't race the download/extract. Waits up to
    ``timeout`` for a peer to release; a stale lock past the deadline (a crashed
    peer) is broken so it can't wedge the bundle forever."""
    lock_path = os.path.join(vdir, ".lock")
    deadline = clock() + timeout
    while True:
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            return (lock_path, fd)
        except FileExistsError:
            if clock() >= deadline:
                try:
                    os.unlink(lock_path)  # break a stale lock, then retry
                except OSError:
                    pass
                continue
            sleep(poll)


def _release_lock(lock: tuple[str, int]) -> None:
    lock_path, fd = lock
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.unlink(lock_path)
    except OSError:
        pass


def ensure_bundle(
    ref: BundleRef,
    base: str,
    download: Callable[[str], bytes],
    *,
    extract: Callable[[bytes, str], int] = extract_tar_gz,
    lock_timeout: float = 30.0,
    poll: float = 0.05,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> str:
    """Make the pinned bundle available locally and return its worker dir.

    Fast path: a valid cache hit returns immediately (no download). Otherwise,
    under a per-version lock: re-check (a peer may have finished while we waited),
    drop any stale/corrupt extract, ``download(url)`` → VERIFY sha256 (mismatch →
    ``BundleError``, no extract) → extract into a temp sibling → write the marker
    → atomically rename into ``extracted/``. ``download``/``extract``/``sleep``/
    ``clock`` are seams so the whole path is unit-tested with no socket."""
    wd = worker_dir(base, ref.plugin_id, ref.version)
    if cache_valid(base, ref):
        return wd
    vdir = version_dir(base, ref.plugin_id, ref.version)
    os.makedirs(vdir, exist_ok=True)
    lock = _acquire_lock(vdir, lock_timeout, poll, sleep, clock)
    try:
        if cache_valid(base, ref):
            return wd
        extracted = extracted_root(base, ref.plugin_id, ref.version)
        if os.path.exists(extracted):
            shutil.rmtree(extracted, ignore_errors=True)
        data = download(ref.url)
        digest = sha256_hex(data)
        if digest.lower() != ref.sha256.lower():
            raise BundleError(
                f"bundle sha256 mismatch for {ref.plugin_id} {ref.version} "
                f"(expected {ref.sha256[:12]}…, got {digest[:12]}…) — refusing to extract"
            )
        tmp = extracted + ".tmp-" + uuid4().hex
        try:
            extract(data, tmp)
            with open(os.path.join(tmp, MARKER_NAME), "w", encoding="utf-8") as f:
                f.write(ref.sha256.lower())
            os.replace(tmp, extracted)  # atomic publish (extracted was removed)
        finally:
            if os.path.isdir(tmp):
                shutil.rmtree(tmp, ignore_errors=True)
        return wd
    finally:
        _release_lock(lock)


def prepare_assignment_spawn(
    assignment: dict[str, Any],
    base: str,
    download: Callable[[str], bytes],
    *,
    extract: Callable[[bytes, str], int] = extract_tar_gz,
    logger: Callable[[str], None] | None = None,
    **lock_kw: Any,
) -> dict[str, Any]:
    """If ``assignment`` carries a bundle ref, ensure it is cached and return a
    COPY whose ``spawn`` spec runs from the extracted dir. No bundle → returns
    the assignment unchanged (back-compat). Propagates ``BundleError`` on a
    verification/fetch failure so the caller reports the assignment failed."""
    ref = parse_bundle_ref(assignment)
    if ref is None:
        return assignment
    wd = ensure_bundle(ref, base, download, extract=extract, **lock_kw)
    if logger:
        logger(f"pinned bundle {ref.plugin_id} {ref.version} ready at {wd}")
    spawn = assignment.get("spawn")
    if not isinstance(spawn, dict):
        return assignment
    updated = dict(assignment)
    updated["spawn"] = redirect_worker_dir(spawn, wd)
    return updated
