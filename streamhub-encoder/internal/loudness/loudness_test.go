package loudness

import (
	"encoding/json"
	"math"
	"sync"
	"testing"
	"time"
)

// segment is a stretch of 1 kHz sine at a given peak level.
type segment struct {
	seconds float64
	dBFS    float64 // peak amplitude; math.Inf(-1) = silence
}

// sineSeq generates interleaved float audio: a phase-continuous 1 kHz sine
// whose peak level follows segs, present on the channels in active (others
// silent).
func sineSeq(rate, channels int, active []int, segs ...segment) []float32 {
	var total int
	for _, s := range segs {
		total += int(s.seconds * float64(rate))
	}
	out := make([]float32, total*channels)
	n := 0
	for _, s := range segs {
		amp := math.Pow(10, s.dBFS/20)
		frames := int(s.seconds * float64(rate))
		for i := 0; i < frames; i++ {
			v := float32(amp * math.Sin(2*math.Pi*1000*float64(n)/float64(rate)))
			for _, c := range active {
				out[n*channels+c] = v
			}
			n++
		}
	}
	return out
}

func measure(rate, channels int, samples []float32) Snapshot {
	m := NewMeter(rate, channels)
	m.WriteFloat(samples)
	return m.Snapshot()
}

func near(t *testing.T, name string, got, want, tol float64) {
	t.Helper()
	if math.IsNaN(got) || math.Abs(got-want) > tol {
		t.Errorf("%s = %.4f, want %.4f ±%g", name, got, want, tol)
	} else {
		t.Logf("%s = %.4f (want %.4f ±%g)", name, got, want, tol)
	}
}

var stereo = []int{0, 1}

// EBU Tech 3341 test 1: stereo 1 kHz sine at −23 dBFS reads −23.0 LUFS.
func TestIntegratedMinus23(t *testing.T) {
	s := measure(48000, 2, sineSeq(48000, 2, stereo, segment{20, -23}))
	near(t, "integrated", s.IntegratedLUFS, -23, 0.1)
	near(t, "momentary", s.MomentaryLUFS, -23, 0.1)
	near(t, "short-term", s.ShortTermLUFS, -23, 0.1)
	near(t, "seconds", s.Seconds, 20, 1e-9)
	for c := range 2 {
		near(t, "rms", s.RMSDBFS[c], -23-3.0103, 0.05)
		near(t, "peak", s.SamplePeakDBFS[c], -23, 0.01)
	}
}

// EBU Tech 3341 test 2: −33 dBFS reads −33.0 LUFS.
func TestIntegratedMinus33(t *testing.T) {
	s := measure(48000, 2, sineSeq(48000, 2, stereo, segment{20, -33}))
	near(t, "integrated", s.IntegratedLUFS, -33, 0.1)
}

// EBU Tech 3341 test 3: −36 / −23 / −36 dBFS for 10 / 60 / 10 s reads
// −23.0 LUFS thanks to the relative gate.
func TestRelativeGate(t *testing.T) {
	s := measure(48000, 2, sineSeq(48000, 2, stereo,
		segment{10, -36}, segment{60, -23}, segment{10, -36}))
	near(t, "integrated", s.IntegratedLUFS, -23, 0.1)
}

// EBU Tech 3341 test 4 style: −72 / −36 / −23 / −36 / −72 dBFS for
// 10 / 10 / 60 / 10 / 10 s reads −23.0 LUFS (absolute + relative gate).
func TestAbsoluteAndRelativeGate(t *testing.T) {
	s := measure(48000, 2, sineSeq(48000, 2, stereo,
		segment{10, -72}, segment{10, -36}, segment{60, -23}, segment{10, -36}, segment{10, -72}))
	near(t, "integrated", s.IntegratedLUFS, -23, 0.1)
}

// Silence: integrated, momentary and short-term report FloorLUFS, LRA 0,
// meters FloorDBFS, and the snapshot is JSON-encodable.
func TestSilence(t *testing.T) {
	m := NewMeter(48000, 2)
	s := m.Snapshot() // nothing written at all
	if s.IntegratedLUFS != FloorLUFS || s.MomentaryLUFS != FloorLUFS || s.Seconds != 0 {
		t.Fatalf("empty meter: %+v", s)
	}
	m.WriteFloat(make([]float32, 5*48000*2))
	s = m.Snapshot()
	if s.IntegratedLUFS != FloorLUFS {
		t.Errorf("integrated = %v, want floor %v", s.IntegratedLUFS, FloorLUFS)
	}
	if s.MomentaryLUFS > -70 || s.ShortTermLUFS > -70 {
		t.Errorf("momentary/short-term = %v/%v, want ≤ −70", s.MomentaryLUFS, s.ShortTermLUFS)
	}
	if s.LoudnessRangeLU != 0 {
		t.Errorf("LRA = %v, want 0", s.LoudnessRangeLU)
	}
	for c := range 2 {
		if s.SamplePeakDBFS[c] != FloorDBFS || s.RMSDBFS[c] != FloorDBFS {
			t.Errorf("ch%d peak/rms = %v/%v, want %v", c, s.SamplePeakDBFS[c], s.RMSDBFS[c], FloorDBFS)
		}
	}
	near(t, "seconds", s.Seconds, 5, 1e-9)
	if _, err := json.Marshal(s); err != nil {
		t.Errorf("snapshot not JSON-encodable: %v", err)
	}
}

// 5.1: the same sine on Ls reads +1.5 dB (10·log10 1.41) louder than on L.
func TestSurroundWeight(t *testing.T) {
	l := measure(48000, 6, sineSeq(48000, 6, []int{0}, segment{10, -23}))
	ls := measure(48000, 6, sineSeq(48000, 6, []int{4}, segment{10, -23}))
	near(t, "L integrated", l.IntegratedLUFS, -23-3.0103, 0.1)
	near(t, "Ls − L", ls.IntegratedLUFS-l.IntegratedLUFS, 10*math.Log10(1.41), 0.01)
	rs := measure(48000, 8, sineSeq(48000, 8, []int{7}, segment{10, -23}))
	near(t, "Rb(7.1) − L", rs.IntegratedLUFS-l.IntegratedLUFS, 10*math.Log10(1.41), 0.01)
}

// 5.1: an LFE-only signal does not contribute to loudness but is metered.
func TestLFEIgnored(t *testing.T) {
	s := measure(48000, 6, sineSeq(48000, 6, []int{3}, segment{10, -6}))
	if s.IntegratedLUFS != FloorLUFS || s.MomentaryLUFS != FloorLUFS {
		t.Errorf("LFE-only: integrated/momentary = %v/%v, want floor", s.IntegratedLUFS, s.MomentaryLUFS)
	}
	near(t, "LFE peak", s.SamplePeakDBFS[3], -6, 0.01)
	if s.SamplePeakDBFS[0] != FloorDBFS {
		t.Errorf("L peak = %v, want floor", s.SamplePeakDBFS[0])
	}
	// With fewer than 6 channels index 3 is an ordinary channel.
	q := measure(48000, 4, sineSeq(48000, 4, []int{3}, segment{10, -23}))
	near(t, "quad ch3", q.IntegratedLUFS, -23-3.0103, 0.1)
}

// Sample peak of a −6 dBFS sine is −6.0 dBFS; it decays to the floor after
// ~1 s of silence.
func TestSamplePeak(t *testing.T) {
	m := NewMeter(48000, 1)
	m.WriteFloat(sineSeq(48000, 1, []int{0}, segment{2, -6}))
	near(t, "peak", m.Snapshot().SamplePeakDBFS[0], -6, 0.01)
	m.WriteFloat(make([]float32, 48000*11/10))
	if p := m.Snapshot().SamplePeakDBFS[0]; p != FloorDBFS {
		t.Errorf("peak after 1.1 s silence = %v, want floor", p)
	}
}

// WriteS16LE with arbitrary (odd, frame-splitting) datagram sizes matches
// WriteFloat of the same quantised samples.
func TestS16LESplitsMatchFloat(t *testing.T) {
	const ch = 6
	src := sineSeq(48000, ch, []int{0, 1, 2, 3, 4, 5},
		segment{2, -20}, segment{2, -30}, segment{1.5, -12})
	pcm := make([]byte, 2*len(src))
	q := make([]float32, len(src))
	for i, v := range src {
		s := int16(math.Round(float64(v) * 32767))
		pcm[2*i], pcm[2*i+1] = byte(s), byte(uint16(s)>>8)
		q[i] = float32(s) / 32768
	}

	a := NewMeter(48000, ch)
	sizes := []int{1, 3, 7, 13, 1001, 2, 17, 4095, 5, 12000, 11}
	for off, k := 0, 0; off < len(pcm); k++ {
		end := min(off+sizes[k%len(sizes)], len(pcm))
		a.WriteS16LE(pcm[off:end])
		off = end
	}
	b := NewMeter(48000, ch)
	b.WriteFloat(q)

	sa, sb := a.Snapshot(), b.Snapshot()
	const tol = 1e-9
	if math.Abs(sa.IntegratedLUFS-sb.IntegratedLUFS) > tol ||
		math.Abs(sa.MomentaryLUFS-sb.MomentaryLUFS) > tol ||
		math.Abs(sa.ShortTermLUFS-sb.ShortTermLUFS) > tol ||
		math.Abs(sa.LoudnessRangeLU-sb.LoudnessRangeLU) > tol ||
		sa.Seconds != sb.Seconds {
		t.Fatalf("S16LE %+v\nfloat %+v", sa, sb)
	}
	for c := range ch {
		if math.Abs(sa.SamplePeakDBFS[c]-sb.SamplePeakDBFS[c]) > tol || math.Abs(sa.RMSDBFS[c]-sb.RMSDBFS[c]) > tol {
			t.Fatalf("ch%d S16LE peak/rms %v/%v float %v/%v", c,
				sa.SamplePeakDBFS[c], sa.RMSDBFS[c], sb.SamplePeakDBFS[c], sb.RMSDBFS[c])
		}
	}
	t.Logf("S16LE == float: I=%.4f M=%.4f S=%.4f LRA=%.4f s=%.2f", sa.IntegratedLUFS, sa.MomentaryLUFS, sa.ShortTermLUFS, sa.LoudnessRangeLU, sa.Seconds)

	// A trailing partial frame is held back, then completed.
	c := NewMeter(48000, 2)
	c.WriteS16LE([]byte{1, 2, 3})
	if s := c.Snapshot().Seconds; s != 0 {
		t.Errorf("partial frame counted: %v s", s)
	}
	c.WriteS16LE([]byte{4})
	if s := c.Snapshot().Seconds; s != 1.0/48000 {
		t.Errorf("completed frame: %v s, want 1/48000", s)
	}
}

// EBU Tech 3342 style: −20 / −30 LUFS alternating every 10 s gives an LRA
// of 10 LU.
func TestLoudnessRange(t *testing.T) {
	s := measure(48000, 2, sineSeq(48000, 2, stereo,
		segment{10, -20}, segment{10, -30}, segment{10, -20}, segment{10, -30}))
	near(t, "LRA", s.LoudnessRangeLU, 10, 1)
	// Tech 3342 test 1 shape: −20 then −30 LUFS, 20 s each.
	s = measure(48000, 2, sineSeq(48000, 2, stereo, segment{20, -20}, segment{20, -30}))
	near(t, "LRA 20s/20s", s.LoudnessRangeLU, 10, 1)
	// Steady programme: LRA ≈ 0.
	s = measure(48000, 2, sineSeq(48000, 2, stereo, segment{20, -23}))
	near(t, "LRA steady", s.LoudnessRangeLU, 0, 0.05)
}

// 44.1 kHz uses the analog-prototype filter design.
func TestOtherSampleRates(t *testing.T) {
	for _, rate := range []int{44100, 32000, 96000} {
		s := measure(rate, 2, sineSeq(rate, 2, stereo, segment{20, -23}))
		near(t, "integrated@"+itoa(rate), s.IntegratedLUFS, -23, 0.1)
	}
}

// The analog-prototype design reproduces the BS.1770 48 kHz tables.
func TestDesignMatchesStandard(t *testing.T) {
	cmp := func(name string, got, want biquad) {
		g := []float64{got.b0, got.b1, got.b2, got.a1, got.a2}
		w := []float64{want.b0, want.b1, want.b2, want.a1, want.a2}
		for i := range g {
			if math.Abs(g[i]-w[i]) > 1e-8 {
				t.Errorf("%s coef %d: designed %.14f, standard %.14f", name, i, g[i], w[i])
			}
		}
	}
	cmp("pre", designPre(48000), preFilter48k)
	cmp("rlb", designRLB(48000), rlbFilter48k)
}

// Reset restarts integration.
func TestReset(t *testing.T) {
	m := NewMeter(48000, 2)
	m.WriteFloat(sineSeq(48000, 2, stereo, segment{10, -10}))
	m.Reset()
	if s := m.Snapshot(); s.IntegratedLUFS != FloorLUFS || s.Seconds != 0 {
		t.Fatalf("after reset: %+v", s)
	}
	m.WriteFloat(sineSeq(48000, 2, stereo, segment{10, -33}))
	near(t, "integrated after reset", m.Snapshot().IntegratedLUFS, -33, 0.1)
}

// Snapshot may run concurrently with the writer (run with -race).
func TestConcurrentSnapshot(t *testing.T) {
	m := NewMeter(48000, 2)
	src := sineSeq(48000, 2, stereo, segment{3, -23})
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-done:
				return
			default:
				_ = m.Snapshot()
			}
		}
	}()
	for i := 0; i < len(src); i += 1920 {
		m.WriteFloat(src[i:min(i+1920, len(src))])
	}
	close(done)
	wg.Wait()
	near(t, "integrated", m.Snapshot().IntegratedLUFS, -23, 0.1)
}

func TestNewMeterPanics(t *testing.T) {
	for _, tc := range [][2]int{{48000, 0}, {48000, 9}, {100, 2}} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("NewMeter(%d, %d) did not panic", tc[0], tc[1])
				}
			}()
			NewMeter(tc[0], tc[1])
		}()
	}
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// BenchmarkS16LE8ch48k feeds 10 s of 7.1 S16LE audio in 20 ms datagrams per
// iteration and reports the real-time factor.
func BenchmarkS16LE8ch48k(b *testing.B) {
	const (
		rate, ch = 48000, 8
		seconds  = 10
	)
	src := sineSeq(rate, ch, []int{0, 1, 2, 3, 4, 5, 6, 7}, segment{seconds, -18})
	pcm := make([]byte, 2*len(src))
	for i, v := range src {
		s := int16(v * 32767)
		pcm[2*i], pcm[2*i+1] = byte(s), byte(uint16(s)>>8)
	}
	const datagram = rate / 50 * ch * 2 // 20 ms = 15360 bytes
	m := NewMeter(rate, ch)
	b.ReportAllocs()
	b.SetBytes(int64(len(pcm)))
	b.ResetTimer()
	start := time.Now()
	for range b.N {
		for off := 0; off < len(pcm); off += datagram {
			m.WriteS16LE(pcm[off:min(off+datagram, len(pcm))])
		}
		_ = m.Snapshot()
	}
	elapsed := time.Since(start).Seconds()
	b.ReportMetric(float64(seconds*b.N)/elapsed, "x_realtime")
}
