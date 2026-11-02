// Package loudness meters programme loudness per ITU-R BS.1770-4 / EBU R128
// (ATSC A/85 uses the same measure) plus per-channel sample peak and RMS,
// for the encoder's audio meters.
//
// The input is interleaved PCM (S16LE from the engine's UDP tap, or float32
// for tests) in L R C LFE Ls Rs [Lb Rb] channel order. Processing is:
//
//   - K-weighting: BS.1770 pre-filter (high shelf) + RLB high-pass, one
//     cascaded biquad pair per channel, float64 state.
//   - 100 ms sub-blocks: each completed sub-block stores its
//     channel-weighted mean-square energy Σ G_i·z_i (G = 1.0 for L/R/C,
//     1.41 for surrounds, 0 for LFE) in a 30-slot ring.
//   - Momentary = last 4 sub-blocks (400 ms); short-term = last 30 (3 s).
//     Both therefore update with a 100 ms hop, i.e. 75 % overlap for the
//     400 ms gating blocks as BS.1770 requires.
//   - Integrated: every momentary block since start/Reset goes through the
//     −70 LUFS absolute and −10 LU relative gates (BS.1770-4).
//   - LRA: every short-term block since start/Reset goes through the
//     −70 LUFS absolute and −20 LU relative gates; LRA = P95 − P10
//     (EBU Tech 3342).
//
// Loudness is −0.691 + 10·log10(Σ G_i·z_i). Gating blocks are only formed
// from audio written after start/Reset (no zero padding), while the
// momentary/short-term display values treat not-yet-received audio as
// silence, so they ramp up during the first 0.4 s / 3 s.
//
// The hot path does not allocate: S16LE is decoded into a fixed scratch
// buffer, channels are filtered channel-major per chunk so filter state
// stays in registers, and gating uses fixed-size histograms.
package loudness

import (
	"fmt"
	"math"
	"sync"
)

const (
	// FloorLUFS is reported for momentary, short-term and integrated
	// loudness whose true value is below it: −Inf for digital silence,
	// "no block passed the gates yet" for integrated, or any level under
	// the −70 LUFS absolute gate. It keeps every Snapshot JSON-encodable
	// (encoding/json rejects ±Inf and NaN).
	FloorLUFS = -70.0
	// FloorDBFS is reported for sample peak and RMS of silent channels.
	FloorDBFS = -120.0
	// MaxChannels is the largest channel count a Meter accepts (7.1).
	MaxChannels = 8
)

const (
	momentarySubBlocks = 4  // 400 ms
	shortTermSubBlocks = 30 // 3 s
	peakSubBlocks      = 10 // 1 s sample-peak window
	scratchSamples     = 8192
	denormalFloor      = 1e-30
	minSampleRate      = 8000
	maxSampleRate      = 384000
)

// Snapshot is a point-in-time reading of a Meter. All values are finite.
type Snapshot struct {
	// MomentaryLUFS is the loudness of the last 400 ms (FloorLUFS minimum).
	MomentaryLUFS float64 `json:"momentaryLufs"`
	// ShortTermLUFS is the loudness of the last 3 s (FloorLUFS minimum).
	ShortTermLUFS float64 `json:"shortTermLufs"`
	// IntegratedLUFS is the gated programme loudness since start/Reset;
	// FloorLUFS while no 400 ms block has passed the gates (e.g. silence).
	IntegratedLUFS float64 `json:"integratedLufs"`
	// LoudnessRangeLU is the EBU Tech 3342 loudness range since
	// start/Reset; 0 until at least one 3 s short-term block passed the
	// gates.
	LoudnessRangeLU float64 `json:"loudnessRangeLu"`
	// SamplePeakDBFS is the per-channel absolute sample peak over a sliding
	// window of the last 10 completed 100 ms sub-blocks plus the sub-block
	// in progress (i.e. 1.0–1.1 s). Not reset by reading; FloorDBFS for a
	// silent channel. Sample peak, not true peak (no oversampling).
	SamplePeakDBFS []float64 `json:"samplePeakDbfs"`
	// RMSDBFS is the per-channel unweighted RMS of the last 4 completed
	// sub-blocks (400 ms), 0 dBFS = full-scale square wave (a full-scale
	// sine reads −3.01, no AES17 +3 dB correction); FloorDBFS when silent.
	RMSDBFS []float64 `json:"rmsDbfs"`
	// Seconds is the amount of audio measured since start/Reset.
	Seconds float64 `json:"seconds"`
}

// filterState is the transposed direct form II state of one channel's two
// K-weighting stages.
type filterState struct {
	z1, z2 float64 // pre-filter
	w1, w2 float64 // RLB
}

// Meter measures loudness of one interleaved PCM stream. Writes must come
// from a single goroutine (they are serialised anyway); Snapshot and Reset
// may be called concurrently from any goroutine.
type Meter struct {
	mu sync.Mutex

	rate     int
	channels int
	subLen   int // frames per 100 ms sub-block
	pre, rlb biquad
	weight   [MaxChannels]float64
	state    [MaxChannels]filterState

	// Partial S16LE frame carried between WriteS16LE calls.
	pend  [2 * MaxChannels]byte
	pendN int

	scratch []float32 // S16LE decode buffer, fixed size

	// Sub-block in progress.
	subPos  int
	subK    float64              // Σ G_i·Σ y_i² (K-weighted)
	subSq   [MaxChannels]float64 // Σ x² per channel (unweighted)
	subPeak [MaxChannels]float64 // max |x| per channel

	// Completed sub-blocks since start/Reset; also the ring write cursor.
	subCount uint64
	kRing    [shortTermSubBlocks]float64              // mean Σ G_i·z_i
	sqRing   [MaxChannels][momentarySubBlocks]float64 // mean x²
	peakRing [MaxChannels][peakSubBlocks]float64      // max |x|
	frames   uint64                                   // since start/Reset
	integ    histogram                                // momentary blocks
	lra      histogram                                // short-term blocks
}

// NewMeter returns a meter for sampleRate Hz (8000–384000; 48000 uses the
// exact BS.1770 coefficients, other rates the analog-prototype design) and
// 1..MaxChannels interleaved channels. Sub-blocks are sampleRate/10 frames.
// It panics on out-of-range arguments: callers validate configuration.
func NewMeter(sampleRate, channels int) *Meter {
	if sampleRate < minSampleRate || sampleRate > maxSampleRate {
		panic(fmt.Sprintf("loudness: sample rate %d out of range [%d, %d]", sampleRate, minSampleRate, maxSampleRate))
	}
	if channels < 1 || channels > MaxChannels {
		panic(fmt.Sprintf("loudness: channel count %d out of range [1, %d]", channels, MaxChannels))
	}
	m := &Meter{
		rate:     sampleRate,
		channels: channels,
		subLen:   sampleRate / 10,
		scratch:  make([]float32, scratchSamples/channels*channels),
	}
	m.pre, m.rlb = kWeighting(sampleRate)
	for c := 0; c < channels; c++ {
		m.weight[c] = channelWeight(c, channels)
	}
	return m
}

// WriteS16LE feeds interleaved signed 16-bit little-endian PCM. b may hold
// any number of bytes: a trailing partial frame is buffered and completed
// by the next call. Do not interleave with WriteFloat while a partial frame
// is pending.
func (m *Meter) WriteS16LE(b []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()

	frameBytes := 2 * m.channels
	if m.pendN > 0 {
		k := copy(m.pend[m.pendN:frameBytes], b)
		m.pendN += k
		b = b[k:]
		if m.pendN < frameBytes {
			return
		}
		buf := m.scratch[:m.channels]
		decodeS16LE(buf, m.pend[:frameBytes])
		m.process(buf)
		m.pendN = 0
	}
	whole := len(b) / frameBytes * frameBytes
	chunkBytes := 2 * len(m.scratch) // whole frames
	for off := 0; off < whole; off += chunkBytes {
		end := min(off+chunkBytes, whole)
		buf := m.scratch[:(end-off)/2]
		decodeS16LE(buf, b[off:end])
		m.process(buf)
	}
	m.pendN = copy(m.pend[:], b[whole:])
}

// decodeS16LE converts len(dst) little-endian int16 samples to ±1.0 floats.
func decodeS16LE(dst []float32, src []byte) {
	_ = src[2*len(dst)-1]
	for i := range dst {
		v := int16(uint16(src[2*i]) | uint16(src[2*i+1])<<8)
		dst[i] = float32(v) * (1.0 / 32768)
	}
}

// WriteFloat feeds interleaved float samples, ±1.0 = full scale. Only whole
// frames are consumed; a trailing partial frame is ignored.
func (m *Meter) WriteFloat(samples []float32) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.process(samples[:len(samples)/m.channels*m.channels])
}

// process consumes whole interleaved frames, splitting them at sub-block
// boundaries. Caller holds mu.
func (m *Meter) process(s []float32) {
	nch := m.channels
	for len(s) > 0 {
		n := min(len(s)/nch, m.subLen-m.subPos)
		chunk := s[:n*nch]
		for c := 0; c < nch; c++ {
			m.runChannel(c, chunk)
		}
		m.subPos += n
		m.frames += uint64(n)
		s = s[n*nch:]
		if m.subPos == m.subLen {
			m.finishSubBlock()
		}
	}
}

// runChannel filters and accumulates channel c of an interleaved chunk.
func (m *Meter) runChannel(c int, chunk []float32) {
	nch := m.channels
	peak := m.subPeak[c]
	var sq float64
	w := m.weight[c]
	if w == 0 { // LFE: meters only, excluded from loudness
		for i := c; i < len(chunk); i += nch {
			x := float64(chunk[i])
			sq += x * x
			if a := math.Abs(x); a > peak {
				peak = a
			}
		}
		m.subSq[c] += sq
		m.subPeak[c] = peak
		return
	}

	p, r := m.pre, m.rlb
	st := &m.state[c]
	z1, z2, w1, w2 := st.z1, st.z2, st.w1, st.w2
	var ek float64
	for i := c; i < len(chunk); i += nch {
		x := float64(chunk[i])
		sq += x * x
		if a := math.Abs(x); a > peak {
			peak = a
		}
		y := p.b0*x + z1
		z1 = p.b1*x - p.a1*y + z2
		z2 = p.b2*x - p.a2*y
		o := r.b0*y + w1
		w1 = r.b1*y - r.a1*o + w2
		w2 = r.b2*y - r.a2*o
		ek += o * o
	}
	// Flush denormals (decaying state after silence slows float maths) and
	// recover from non-finite input. Per chunk is enough: decaying from
	// 1e-30 into the denormal range takes far longer than one sub-block.
	st.z1, st.z2, st.w1, st.w2 = flush(z1), flush(z2), flush(w1), flush(w2)
	m.subK += w * ek
	m.subSq[c] += sq
	m.subPeak[c] = peak
}

// flush zeroes tiny or non-finite filter state.
func flush(v float64) float64 {
	if a := math.Abs(v); a < denormalFloor || a > math.MaxFloat64 || v != v {
		return 0
	}
	return v
}

// finishSubBlock closes the current 100 ms sub-block, pushes it into the
// rings and forms the gating blocks it completes. Caller holds mu.
func (m *Meter) finishSubBlock() {
	inv := 1 / float64(m.subLen)
	m.kRing[m.subCount%shortTermSubBlocks] = m.subK * inv
	for c := 0; c < m.channels; c++ {
		m.sqRing[c][m.subCount%momentarySubBlocks] = m.subSq[c] * inv
		m.peakRing[c][m.subCount%peakSubBlocks] = m.subPeak[c]
		m.subSq[c], m.subPeak[c] = 0, 0
	}
	m.subK, m.subPos = 0, 0
	m.subCount++

	if m.subCount >= momentarySubBlocks {
		m.integ.add(m.windowEnergy(momentarySubBlocks))
	}
	if m.subCount >= shortTermSubBlocks {
		m.lra.add(m.windowEnergy(shortTermSubBlocks))
	}
}

// windowEnergy is the mean weighted energy of the last n completed
// sub-blocks (slots not yet written since Reset hold zero).
func (m *Meter) windowEnergy(n int) float64 {
	var e float64
	for k := 1; k <= n; k++ {
		e += m.kRing[(m.subCount+shortTermSubBlocks-uint64(k))%shortTermSubBlocks]
	}
	return e / float64(n)
}

// Snapshot returns the current readings. Safe for concurrent use.
func (m *Meter) Snapshot() Snapshot {
	peaks := make([]float64, m.channels)
	rms := make([]float64, m.channels)

	m.mu.Lock()
	defer m.mu.Unlock()

	s := Snapshot{
		MomentaryLUFS:   floorLUFS(energyToLUFS(m.windowEnergy(momentarySubBlocks))),
		ShortTermLUFS:   floorLUFS(energyToLUFS(m.windowEnergy(shortTermSubBlocks))),
		IntegratedLUFS:  FloorLUFS,
		LoudnessRangeLU: m.lra.loudnessRange(),
		SamplePeakDBFS:  peaks,
		RMSDBFS:         rms,
		Seconds:         float64(m.frames) / float64(m.rate),
	}
	if l, ok := m.integ.integrated(); ok {
		s.IntegratedLUFS = floorLUFS(l)
	}
	for c := 0; c < m.channels; c++ {
		pk := m.subPeak[c]
		for _, v := range m.peakRing[c] {
			pk = max(pk, v)
		}
		var ms float64
		for _, v := range m.sqRing[c] {
			ms += v
		}
		peaks[c] = floorDB(20 * math.Log10(pk))
		rms[c] = floorDB(10 * math.Log10(ms/momentarySubBlocks))
	}
	return s
}

// Reset restarts the measurement (e.g. on a new programme): integrated,
// LRA, Seconds, the momentary/short-term/peak/RMS windows and the partial
// sub-block are cleared. K-filter state and a pending partial S16LE frame
// are kept so the stream stays aligned and no filter transient is
// introduced.
func (m *Meter) Reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.subPos, m.subK, m.subCount, m.frames = 0, 0, 0, 0
	m.subSq = [MaxChannels]float64{}
	m.subPeak = [MaxChannels]float64{}
	m.kRing = [shortTermSubBlocks]float64{}
	m.sqRing = [MaxChannels][momentarySubBlocks]float64{}
	m.peakRing = [MaxChannels][peakSubBlocks]float64{}
	m.integ = histogram{}
	m.lra = histogram{}
}

// floorLUFS maps −Inf, NaN and anything under the absolute gate to FloorLUFS.
func floorLUFS(l float64) float64 {
	if !(l > FloorLUFS) {
		return FloorLUFS
	}
	return l
}

// floorDB maps −Inf, NaN and anything under FloorDBFS to FloorDBFS.
func floorDB(v float64) float64 {
	if !(v > FloorDBFS) {
		return FloorDBFS
	}
	return v
}
