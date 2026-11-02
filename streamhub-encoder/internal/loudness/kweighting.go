package loudness

import "math"

// biquad holds normalised second-order IIR coefficients (a0 == 1):
//
//	y[n] = b0·x[n] + b1·x[n−1] + b2·x[n−2] − a1·y[n−1] − a2·y[n−2]
type biquad struct {
	b0, b1, b2, a1, a2 float64
}

// ITU-R BS.1770-4 Table 1: stage 1 pre-filter (high shelf, models the
// acoustic effect of the head) at 48 kHz.
var preFilter48k = biquad{
	b0: 1.53512485958697,
	b1: -2.69169618940638,
	b2: 1.19839281085285,
	a1: -1.69065929318241,
	a2: 0.73248077421585,
}

// ITU-R BS.1770-4 Table 2: stage 2 RLB weighting curve (high-pass) at
// 48 kHz.
var rlbFilter48k = biquad{
	b0: 1.0,
	b1: -2.0,
	b2: 1.0,
	a1: -1.99004745483398,
	a2: 0.99007225036621,
}

// Analog-prototype parameters of the two K-weighting stages. They are the
// values that reproduce the BS.1770 48 kHz tables through the bilinear
// transform (as derived for libebur128), so the filters can be designed
// for any sample rate.
const (
	preF0   = 1681.974450955533
	preGain = 3.999843853973347 // dB
	preQ    = 0.7071752369554196
	preVbEx = 0.4996667741545416 // exponent: Vb = Vh^preVbEx

	rlbF0 = 38.13547087602444
	rlbQ  = 0.5003270373238773
)

// kWeighting returns the two cascaded K-weighting stages for sampleRate.
// 48 kHz uses the exact coefficients published in the standard; every
// other rate uses the analog-prototype design.
func kWeighting(sampleRate int) (pre, rlb biquad) {
	if sampleRate == 48000 {
		return preFilter48k, rlbFilter48k
	}
	return designPre(float64(sampleRate)), designRLB(float64(sampleRate))
}

// designPre designs the stage-1 high-shelf for sample rate fs.
func designPre(fs float64) biquad {
	k := math.Tan(math.Pi * preF0 / fs)
	vh := math.Pow(10, preGain/20)
	vb := math.Pow(vh, preVbEx)
	a0 := 1 + k/preQ + k*k
	return biquad{
		b0: (vh + vb*k/preQ + k*k) / a0,
		b1: 2 * (k*k - vh) / a0,
		b2: (vh - vb*k/preQ + k*k) / a0,
		a1: 2 * (k*k - 1) / a0,
		a2: (1 - k/preQ + k*k) / a0,
	}
}

// designRLB designs the stage-2 RLB high-pass for sample rate fs. As in the
// standard, the numerator is left un-normalised (1, −2, 1).
func designRLB(fs float64) biquad {
	k := math.Tan(math.Pi * rlbF0 / fs)
	a0 := 1 + k/rlbQ + k*k
	return biquad{
		b0: 1,
		b1: -2,
		b2: 1,
		a1: 2 * (k*k - 1) / a0,
		a2: (1 - k/rlbQ + k*k) / a0,
	}
}

// channelWeight returns the BS.1770 channel weighting G_i for channel index
// ch of an n-channel stream in L R C LFE Ls Rs [Lb Rb] order.
//
// With 6 or more channels, index 3 is the LFE (excluded, G = 0) and every
// index ≥ 4 is a surround channel (G = 1.41, ≈ +1.5 dB). Streams with fewer
// than 6 channels (mono, stereo, 3.0, quad, 5.0 layouts are ambiguous in a
// bare channel count) weight every channel 1.0.
func channelWeight(ch, n int) float64 {
	if n < 6 {
		return 1
	}
	switch {
	case ch == 3:
		return 0
	case ch >= 4:
		return 1.41
	default:
		return 1
	}
}
