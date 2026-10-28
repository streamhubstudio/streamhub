"""Shared capture — the pure fan-out core (ring + samplers + dispatch).

Locks the owner-item-33 invariant: ONE decoded stream feeds N model consumers,
so adding a consumer never adds a decode. No cv2/torch — synthetic frames + an
explicit clock.
"""
from vision_edge.capture import FrameRing, SharedCapture, make_sampler
from vision_edge.sampler import FpsThrottle


class TestFrameRing:
    def test_push_latest_and_len(self):
        r = FrameRing(maxlen=3)
        assert r.latest() is None
        r.push(1, "a")
        r.push(2, "b")
        assert r.latest() == (2, "b")
        assert len(r) == 2
        assert r.pushed == 2 and r.dropped == 0

    def test_drops_oldest_when_full(self):
        r = FrameRing(maxlen=2)
        r.push(1, "a")
        r.push(2, "b")
        r.push(3, "c")  # evicts (1,"a")
        assert len(r) == 2
        assert r.latest() == (3, "c")
        assert r.pushed == 3 and r.dropped == 1

    def test_maxlen_floor_is_one(self):
        r = FrameRing(maxlen=0)
        assert r.maxlen == 1
        r.push(1, "a")
        r.push(2, "b")
        assert r.latest() == (2, "b") and len(r) == 1


class TestMakeSampler:
    def test_counting_is_fixed_fps(self):
        wants = make_sampler("counting", fps=2.0)  # 0.5s interval
        assert wants(0, 0.0) is True
        assert wants(1, 0.3) is False
        assert wants(2, 0.5) is True

    def test_crowd_is_one_per_interval(self):
        wants = make_sampler("crowd", interval_sec=10.0)
        assert wants(0, 100.0) is True
        assert wants(1, 105.0) is False   # within the 10s interval
        assert wants(2, 110.0) is True

    def test_demography_is_one_per_interval(self):
        wants = make_sampler("demography", interval_sec=60.0)
        assert wants(0, 0.0) is True
        assert wants(1, 30.0) is False
        assert wants(2, 60.0) is True

    def test_occupancy_is_adaptive_skip(self):
        # Cold adaptive sampler skips 9 decoded frames between inferences.
        wants = make_sampler("occupancy")
        assert wants(1, 0.0) is True          # first inference
        results = [wants(i, 0.0) for i in range(2, 12)]  # 9 skips then a fire
        assert results[:9] == [False] * 9
        assert results[9] is True

    def test_unknown_model_defaults_to_fixed(self):
        wants = make_sampler("mystery", fps=1.0)
        assert wants(0, 0.0) is True
        assert wants(1, 0.5) is False
        assert wants(2, 1.0) is True


class TestSharedCaptureFanout:
    def test_two_consumers_each_keep_own_cadence(self):
        sc = SharedCapture()
        sc.add_consumer("counting", make_sampler("counting", fps=10.0))   # 0.1s
        sc.add_consumer("crowd", make_sampler("crowd", interval_sec=1.0))  # 1s
        assert set(sc.consumer_names()) == {"counting", "crowd"}

        # t=0.0: both fire (first frame each).
        assert set(sc.dispatch("f0", 0.0)) == {"counting", "crowd"}
        # t=0.2: only counting is due again (crowd interval not elapsed).
        assert sc.dispatch("f1", 0.2) == ["counting"]
        # t=1.0: counting due AND crowd's 1s interval elapsed.
        assert set(sc.dispatch("f2", 1.0)) == {"counting", "crowd"}

    def test_ring_and_seq_advance_once_per_frame(self):
        sc = SharedCapture()
        sc.add_consumer("a", make_sampler("counting", fps=100.0))
        sc.add_consumer("b", make_sampler("counting", fps=100.0))
        sc.dispatch("f0", 0.0)
        sc.dispatch("f1", 0.1)
        # ONE decode → ONE ring push + ONE seq bump, regardless of 2 consumers.
        assert sc.seq == 2
        assert sc.ring.pushed == 2
        assert sc.ring.latest() == (2, "f1")

    def test_adding_a_consumer_adds_no_decode(self):
        # The whole point: N consumers share ONE decoded frame. dispatch pushes
        # the frame ONCE no matter how many consumers subscribe.
        one = SharedCapture()
        one.add_consumer("counting", make_sampler("counting", fps=100.0))
        three = SharedCapture()
        for m in ("counting", "occupancy", "crowd"):
            three.add_consumer(m, make_sampler(m, fps=100.0, interval_sec=0.01))
        for now in (0.0, 0.05, 0.1):
            one.dispatch("f", now)
            three.dispatch("f", now)
        assert one.ring.pushed == three.ring.pushed == 3  # decode count is N-independent

    def test_remove_consumer(self):
        sc = SharedCapture()
        sc.add_consumer("a", lambda i, n: True)
        sc.add_consumer("b", lambda i, n: True)
        sc.remove_consumer("a")
        assert sc.consumer_names() == ["b"]
        assert sc.dispatch("f", 0.0) == ["b"]


class TestDecodeGateSharesWithFpsThrottle:
    def test_decode_gate_caps_the_source_once(self):
        # The per-source decode cap is an FpsThrottle the reader owns; assert its
        # cadence so the shared loop decodes at most decode_fps/sec.
        gate = FpsThrottle(4.0)  # 0.25s
        stamps = [0.0, 0.1, 0.2, 0.25, 0.3, 0.5]
        decoded = [t for t in stamps if gate.should_emit(t)]
        assert decoded == [0.0, 0.25, 0.5]
