"""Samplers — fixed-cadence throttle + Vision One adaptive skip."""
from vision_edge.sampler import AdaptiveFrameSampler, FpsThrottle


def test_fps_throttle_first_always_emits():
    t = FpsThrottle(3.5)
    assert t.should_emit(100.0) is True


def test_fps_throttle_respects_interval():
    t = FpsThrottle(2.0)  # min_interval 0.5s
    assert t.should_emit(0.0) is True
    assert t.should_emit(0.3) is False
    assert t.should_emit(0.5) is True
    assert t.should_emit(0.9) is False
    assert t.should_emit(1.0) is True


def test_fps_throttle_reset():
    t = FpsThrottle(1.0)
    assert t.should_emit(10.0) is True
    t.reset()
    assert t.should_emit(10.1) is True


def test_adaptive_cold_start_default_skip():
    # activity=0, load=0.5 → int(9*(0.5+0.3+0.2)) = 9.
    s = AdaptiveFrameSampler()
    assert s.frames_to_skip() == 9


def test_adaptive_more_activity_fewer_skips():
    s = AdaptiveFrameSampler()
    for _ in range(20):
        s.update_activity(10)  # saturate activity
    # activity→1 → activity_factor 0; skip = int(9*(0.5+0+0.5*0.4)) = int(9*0.7)=6.
    assert s.frames_to_skip() == 6


def test_adaptive_high_load_more_skips_but_clamped():
    s = AdaptiveFrameSampler()
    for _ in range(50):
        s.update_system_load(40)  # saturate load → 1.0
    # activity 0 → int(9*(0.5+0.3+0.4)) = int(9*1.2) = 10.
    assert s.frames_to_skip() == 10


def test_adaptive_clamped_to_min():
    s = AdaptiveFrameSampler(base_skip=2, min_skip=4, max_skip=19)
    assert s.frames_to_skip() >= 4


def test_adaptive_clamped_to_max():
    s = AdaptiveFrameSampler(base_skip=40, min_skip=4, max_skip=19)
    for _ in range(50):
        s.update_system_load(40)
    assert s.frames_to_skip() == 19


def test_adaptive_activity_ema_moves_gradually():
    s = AdaptiveFrameSampler()
    s.update_activity(5)  # one sample of 1.0
    assert abs(s.activity_score - 0.3) < 1e-9  # 0.7*0 + 0.3*1


def test_adaptive_load_ema_moves_gradually():
    s = AdaptiveFrameSampler()
    s.update_system_load(20)  # one sample of 1.0
    assert abs(s.system_load - 0.6) < 1e-9  # 0.8*0.5 + 0.2*1
