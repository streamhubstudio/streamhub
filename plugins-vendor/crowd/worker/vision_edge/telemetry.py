"""
Node telemetry — cpu/mem/disk (stdlib + optional psutil) and gpu/vram (via an
``nvidia-smi`` subprocess parse). The ``stats`` blob shape MATCHES what the
master persists (streamhub-core cluster.service ``selfStats`` + the
``EdgeGridCaps`` grid block the scheduler reads):

    {role:'edge', cores, loadavg1, cpu, memTotal, memFree, memUsedRatio,
     disk:{total, free, usedRatio}, grid:{gpu, vramGb, vramFreeMb, gpuName,
     capabilities}}

The parsers (``parse_nvidia_smi``, ``capacity_streams``) are pure and
unit-tested; ``collect_stats`` wires them to the OS and never raises (a probe
failure degrades to a null/absent field, never a crash — telemetry must not
take the edge down).
"""
from __future__ import annotations

import os
import shutil
import subprocess
from typing import Any, Sequence

# Vision One LoadBalancer VRAM math (CLUSTER.md): reserve a 500 MB buffer per
# node, each occupancy stream costs ~200 MB → streams = (free - 500) / 200.
VRAM_BUFFER_MB = 500
VRAM_PER_STREAM_MB = 200


def capacity_streams(
    vram_free_mb: float | None,
    buffer_mb: int = VRAM_BUFFER_MB,
    per_stream_mb: int = VRAM_PER_STREAM_MB,
) -> int:
    """Max concurrent vision streams a node can host given free VRAM.

    Port of Vision One's ``max_streams = (vram_free - 500MB) / 200MB``. A node
    with no GPU (None) or insufficient VRAM returns 0 (won't receive vision
    assignments); the scheduler on the master enforces this same guard.
    """
    if vram_free_mb is None or per_stream_mb <= 0:
        return 0
    return max(0, int((vram_free_mb - buffer_mb) // per_stream_mb))


def parse_nvidia_smi(output: str) -> dict[str, Any]:
    """Parse ``nvidia-smi --query-gpu=name,memory.total,memory.free
    --format=csv,noheader,nounits`` output → grid caps.

    Sums VRAM across GPUs, keeps the first GPU's name, tolerant of blank lines
    and partial rows. Empty/garbage input ⇒ a no-GPU block.
    """
    total_mb = 0.0
    free_mb = 0.0
    name: str | None = None
    found = False
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 3:
            continue
        g_name, g_total, g_free = parts[0], parts[1], parts[2]
        try:
            t = float(g_total)
            fr = float(g_free)
        except (TypeError, ValueError):
            continue
        found = True
        total_mb += t
        free_mb += fr
        if name is None and g_name:
            name = g_name
    if not found:
        return no_gpu_caps()
    return {
        "gpu": True,
        "vramGb": round(total_mb / 1024.0, 2),
        "vramFreeMb": int(free_mb),
        "gpuName": name,
        "capacityStreams": capacity_streams(free_mb),
    }


def no_gpu_caps(capabilities: Sequence[str] | None = None) -> dict[str, Any]:
    return {
        "gpu": False,
        "vramGb": None,
        "vramFreeMb": None,
        "gpuName": None,
        "capacityStreams": 0,
    }


def probe_gpu(runner=None) -> dict[str, Any]:
    """Run nvidia-smi (if present) and parse it. ``runner`` is injectable
    (returns the raw stdout string, or None when nvidia-smi is unavailable) so
    tests never shell out. Any failure degrades to a no-GPU block."""
    if runner is None:
        runner = _run_nvidia_smi
    try:
        out = runner()
    except Exception:  # noqa: BLE001 - a probe must never crash telemetry
        out = None
    if not out:
        return no_gpu_caps()
    return parse_nvidia_smi(out)


def _run_nvidia_smi() -> str | None:
    if shutil.which("nvidia-smi") is None:
        return None
    try:
        res = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,memory.free",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return res.stdout if res.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def collect_stats(
    capabilities: Sequence[str], data_dir: str = "/", gpu_runner=None
) -> dict[str, Any]:
    """Assemble the full telemetry blob. Never raises."""
    cores = os.cpu_count() or 1
    try:
        load1 = os.getloadavg()[0]
    except (OSError, AttributeError):
        load1 = 0.0

    mem = _mem_stats()
    disk = _disk_stats(data_dir)
    grid = probe_gpu(gpu_runner)
    grid["capabilities"] = list(capabilities)

    stats: dict[str, Any] = {
        "role": "edge",
        "cores": cores,
        "loadavg1": round(load1, 2),
        "cpu": round(load1 / cores, 3) if cores > 0 else 0.0,
        "disk": disk,
        "grid": grid,
    }
    stats.update(mem)
    return stats


def _mem_stats() -> dict[str, Any]:
    try:
        import psutil  # optional

        vm = psutil.virtual_memory()
        total, free = vm.total, vm.available
    except Exception:  # noqa: BLE001 - fall back to /proc or a null block
        total, free = _mem_from_proc()
    if not total:
        return {"memTotal": None, "memFree": None, "memUsedRatio": None}
    return {
        "memTotal": total,
        "memFree": free,
        "memUsedRatio": round((total - free) / total, 3) if total else None,
    }


def _mem_from_proc() -> tuple[int, int]:
    """Linux /proc/meminfo fallback (no psutil). (0, 0) elsewhere."""
    total = free = 0
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    total = int(line.split()[1]) * 1024
                elif line.startswith("MemAvailable:"):
                    free = int(line.split()[1]) * 1024
                if total and free:
                    break
    except (OSError, ValueError, IndexError):
        return (0, 0)
    return (total, free)


def _disk_stats(path: str) -> dict[str, Any]:
    try:
        du = shutil.disk_usage(path if path and os.path.exists(path) else "/")
        return {
            "total": du.total,
            "free": du.free,
            "usedRatio": round((du.total - du.free) / du.total, 3) if du.total else None,
        }
    except OSError:
        return {"total": None, "free": None, "usedRatio": None}
