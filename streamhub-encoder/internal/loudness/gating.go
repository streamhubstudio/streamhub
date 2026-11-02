package loudness

import "math"

// Gating constants (ITU-R BS.1770-4 §2.8, EBU Tech 3342).
const (
	absoluteGate      = -70.0 // LUFS, both integrated and LRA
	integratedRelGate = -10.0 // LU below the abs-gated mean (BS.1770)
	lraRelGate        = -20.0 // LU below the abs-gated mean (Tech 3342)
	lraLowPercentile  = 0.10
	lraHighPercentile = 0.95
)

// Block loudness values are binned into a fixed histogram instead of being
// stored, so memory stays constant however long a program runs (a 24 h
// integration would otherwise need ~864k blocks per measure). Bins are
// 0.01 LU wide from −70 to +30 LUFS; anything louder lands in the top bin
// (its energy is still accounted exactly). Each bin keeps the exact energy
// sum of its blocks, so the integrated value is exact and only the
// position of the relative gate is quantised to 0.01 LU.
const (
	histMin  = absoluteGate
	histStep = 0.01
	histBins = 10000 // (30 − (−70)) / 0.01
)

// histogram accumulates gating blocks that passed the absolute gate.
type histogram struct {
	count  [histBins]uint32
	energy [histBins]float64
	n      uint64  // blocks above the absolute gate
	sum    float64 // their total energy
}

// energyToLUFS converts a channel-weighted mean-square energy into LUFS:
// L = −0.691 + 10·log10(Σ G_i·z_i). Zero energy yields −Inf.
func energyToLUFS(e float64) float64 {
	return -0.691 + 10*math.Log10(e)
}

// binOf maps a loudness to its histogram bin, clamped to the valid range.
func binOf(l float64) int {
	i := int((l - histMin) / histStep)
	if i < 0 {
		return 0
	}
	if i >= histBins {
		return histBins - 1
	}
	return i
}

// add records one block energy; blocks at or below the absolute gate
// (including digital silence and NaN) are discarded.
func (h *histogram) add(e float64) {
	l := energyToLUFS(e)
	if !(l > absoluteGate) {
		return
	}
	i := binOf(l)
	h.count[i]++
	h.energy[i] += e
	h.n++
	h.sum += e
}

// relativeStart returns the first bin at or above the relative gate placed
// relGate LU below the loudness of the mean abs-gated energy.
func (h *histogram) relativeStart(relGate float64) int {
	return binOf(energyToLUFS(h.sum/float64(h.n)) + relGate)
}

// integrated returns the BS.1770 gated loudness, or ok=false when no block
// survives the gates.
func (h *histogram) integrated() (lufs float64, ok bool) {
	if h.n == 0 {
		return 0, false
	}
	var n uint64
	var e float64
	for i := h.relativeStart(integratedRelGate); i < histBins; i++ {
		n += uint64(h.count[i])
		e += h.energy[i]
	}
	if n == 0 {
		return 0, false
	}
	return energyToLUFS(e / float64(n)), true
}

// loudnessRange returns the EBU Tech 3342 LRA in LU: the spread between the
// 10th and 95th percentiles of the short-term loudness distribution after
// the −70 LUFS absolute and −20 LU relative gates. 0 without data.
func (h *histogram) loudnessRange() float64 {
	if h.n == 0 {
		return 0
	}
	start := h.relativeStart(lraRelGate)
	var n uint64
	for i := start; i < histBins; i++ {
		n += uint64(h.count[i])
	}
	if n == 0 {
		return 0
	}
	return h.percentile(start, n, lraHighPercentile) - h.percentile(start, n, lraLowPercentile)
}

// percentile returns the loudness (bin centre) of the value of rank
// round((n−1)·p) among the n blocks in bins ≥ start.
func (h *histogram) percentile(start int, n uint64, p float64) float64 {
	rank := uint64(float64(n-1)*p + 0.5)
	var cum uint64
	for i := start; i < histBins; i++ {
		cum += uint64(h.count[i])
		if cum > rank {
			return histMin + (float64(i)+0.5)*histStep
		}
	}
	return histMin + (histBins-0.5)*histStep
}
