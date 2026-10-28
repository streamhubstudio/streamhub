package healthworker

import "regexp"

// Port of tscc.js: MPEG-TS continuity-counter analysis. Per PID the 4-bit CC
// increments for every packet carrying payload; a skip means lost packets or
// a mux glitch. discontinuity_indicator resets it and one duplicate (same
// CC) is legal.

// TSPacketSize is the MPEG-TS packet size.
const TSPacketSize = 188

const (
	syncByte = 0x47
	nullPID  = 0x1fff
)

// TSResult is a continuity analysis.
type TSResult struct {
	Packets    int `json:"packets"`
	CCErrors   int `json:"ccErrors"`
	SyncLosses int `json:"syncLosses"`
	PIDs       int `json:"pids"`
}

// AnalyzeTSContinuity analyzes a TS buffer (the caller bounds the read).
func AnalyzeTSContinuity(b []byte) TSResult {
	lastCC := map[int]byte{}
	var r TSResult
	i := 0
	for i+TSPacketSize <= len(b) {
		if b[i] != syncByte {
			r.SyncLosses++
			j := i + 1
			for j+TSPacketSize <= len(b) && b[j] != syncByte {
				j++
			}
			i = j
			continue
		}
		r.Packets++
		pid := int(b[i+1]&0x1f)<<8 | int(b[i+2])
		afc := (b[i+3] >> 4) & 0x3
		cc := b[i+3] & 0x0f
		hasPayload := afc&0x1 == 1
		disc := false
		if afc&0x2 == 2 && b[i+4] > 0 {
			disc = b[i+5]&0x80 != 0
		}
		if pid != nullPID && hasPayload {
			if prev, seen := lastCC[pid]; seen && !disc {
				if expected := (prev + 1) & 0x0f; cc != expected && cc != prev {
					r.CCErrors++
				}
			}
			lastCC[pid] = cc
		}
		i += TSPacketSize
	}
	r.PIDs = len(lastCC)
	return r
}

var tsRe = regexp.MustCompile(`(?i)\.ts(\?.*)?$`)

// IsTSSegment reports a raw MPEG-TS segment name (CC analysis applies).
func IsTSSegment(uri string) bool { return tsRe.MatchString(uri) }
