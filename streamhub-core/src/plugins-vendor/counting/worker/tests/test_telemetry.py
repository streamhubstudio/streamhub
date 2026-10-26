"""Telemetry — nvidia-smi parse, VRAM capacity math, stats blob shape."""
from vision_edge.telemetry import (
    capacity_streams,
    collect_stats,
    no_gpu_caps,
    parse_nvidia_smi,
    probe_gpu,
)


def test_capacity_streams_vision_one_formula():
    # (14200 - 500) / 200 = 68.5 → 68.
    assert capacity_streams(14200) == 68
    assert capacity_streams(700) == 1        # (700-500)/200 = 1
    assert capacity_streams(600) == 0        # (600-500)/200 = 0.5 → 0
    assert capacity_streams(400) == 0        # negative → clamped 0
    assert capacity_streams(None) == 0       # no GPU


def test_parse_nvidia_smi_single_gpu():
    out = "NVIDIA A10G, 23028, 22000\n"
    caps = parse_nvidia_smi(out)
    assert caps["gpu"] is True
    assert caps["gpuName"] == "NVIDIA A10G"
    assert caps["vramFreeMb"] == 22000
    assert abs(caps["vramGb"] - round(23028 / 1024, 2)) < 1e-6
    assert caps["capacityStreams"] == capacity_streams(22000)


def test_parse_nvidia_smi_multi_gpu_sums():
    out = "Tesla T4, 15360, 15000\nTesla T4, 15360, 10000\n"
    caps = parse_nvidia_smi(out)
    assert caps["vramFreeMb"] == 25000       # summed
    assert caps["gpuName"] == "Tesla T4"     # first name


def test_parse_nvidia_smi_tolerant_of_junk():
    out = "\n\ngarbage line\nTesla T4, 15360, 15000\nbad,row\n"
    caps = parse_nvidia_smi(out)
    assert caps["gpu"] is True and caps["vramFreeMb"] == 15000


def test_parse_nvidia_smi_empty_is_no_gpu():
    caps = parse_nvidia_smi("")
    assert caps == no_gpu_caps()
    assert caps["gpu"] is False and caps["vramFreeMb"] is None


def test_probe_gpu_injected_runner():
    caps = probe_gpu(runner=lambda: "NVIDIA L4, 24000, 20000")
    assert caps["gpu"] is True and caps["vramFreeMb"] == 20000


def test_probe_gpu_runner_failure_degrades():
    def boom():
        raise RuntimeError("nvidia-smi missing")

    assert probe_gpu(runner=boom)["gpu"] is False
    assert probe_gpu(runner=lambda: None)["gpu"] is False


def test_collect_stats_shape_no_gpu():
    stats = collect_stats(["vision", "yolo"], gpu_runner=lambda: None)
    assert stats["role"] == "edge"
    assert "cores" in stats and "cpu" in stats and "loadavg1" in stats
    assert "memTotal" in stats and "memUsedRatio" in stats
    assert "disk" in stats and set(stats["disk"]) >= {"total", "free", "usedRatio"}
    assert stats["grid"]["gpu"] is False
    assert stats["grid"]["capabilities"] == ["vision", "yolo"]


def test_collect_stats_with_gpu():
    stats = collect_stats(["vision"], gpu_runner=lambda: "NVIDIA A10G, 23028, 22000")
    assert stats["grid"]["gpu"] is True
    assert stats["grid"]["vramFreeMb"] == 22000
    assert stats["grid"]["capabilities"] == ["vision"]
