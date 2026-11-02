// Package tsbus is the per-channel internal transport: the engine sends its
// MPEG-TS to a loopback UDP port owned by encoderd, which fans every datagram
// out to the output processes (non-blocking: a dead or slow output only loses
// its own copy) and analyses the stream on the way (bitrate, video frame rate,
// continuity errors, PCR-vs-wallclock drift). The analysis is the engine's
// health signal: no packets = stalled engine → the watchdog restarts it.
package tsbus

import (
	"sync"
	"time"
)

// Stream types of interest in the PMT.
const (
	stH264 = 0x1b
	stH265 = 0x24
	stAAC  = 0x0f
	stAACL = 0x11
)

// Analyzer is a streaming MPEG-TS analyser. Feed it whole 188-byte packets
// (any multiple per call). Safe for one writer + concurrent readers.
type Analyzer struct {
	mu sync.Mutex

	now func() time.Time

	packets, bytes int64
	ccErrors       int64
	syncErrors     int64
	lastCC         map[uint16]byte
	pmtPID         int
	videoPID       int
	audioPID       int
	pcrPID         int
	videoCodec     string
	audioCodec     string
	videoFrames    int64
	audioFrames    int64

	// PCR drift: (pcr - pcr0) vs (wall - wall0)
	pcr0    int64 // 27 MHz units
	wall0   time.Time
	lastPCR int64
	driftMs float64
	pcrDisc int64 // discontinuities (jump > 1 s or backwards)
	pcrSpan int64 // sum of in-range PCR deltas (stream seconds x 27 MHz)

	// video PTS segments (90 kHz): robust duration even with B-frame reordering
	ptsSegStart, ptsSegMax int64
	ptsTotal               int64
	ptsSeen                bool
	ptsJumps               int64
	lastPCRAt              time.Time

	firstAt, lastAt time.Time

	// 1-second rate windows
	win        []sample
	lastSample time.Time
}

type sample struct {
	at     time.Time
	bytes  int64
	frames int64
}

// NewAnalyzer creates an analyzer using the wall clock.
func NewAnalyzer() *Analyzer {
	return &Analyzer{now: time.Now, lastCC: map[uint16]byte{}, pmtPID: -1, videoPID: -1, audioPID: -1, pcrPID: -1}
}

// Stats is a snapshot.
type Stats struct {
	Packets       int64     `json:"packets"`
	Bytes         int64     `json:"bytes"`
	BitrateKbps   float64   `json:"bitrateKbps"` // last ~5 s
	FPS           float64   `json:"fps"`         // video PES/s, last ~5 s
	VideoFrames   int64     `json:"videoFrames"`
	AudioFrames   int64     `json:"audioFrames"`
	VideoCodec    string    `json:"videoCodec,omitempty"`
	AudioCodec    string    `json:"audioCodec,omitempty"`
	VideoPID      int       `json:"videoPid"`
	AudioPID      int       `json:"audioPid"`
	CCErrors      int64     `json:"ccErrors"`
	SyncErrors    int64     `json:"syncErrors"`
	PCRDriftMs    float64   `json:"pcrDriftMs"` // + = stream clock ahead of wall clock
	PCRResets     int64     `json:"pcrDiscontinuities"`
	StreamSeconds float64   `json:"streamSeconds"` // PCR-measured duration
	VideoSeconds  float64   `json:"videoSeconds"`  // video PTS span (sum of contiguous segments)
	PTSJumps      int64     `json:"ptsJumps"`
	FirstPacketAt time.Time `json:"firstPacketAt,omitempty"`
	LastPacketAt  time.Time `json:"lastPacketAt,omitempty"`
}

// Write implements io.Writer (packets must be 188-aligned per call).
func (a *Analyzer) Write(p []byte) (int, error) {
	a.Feed(p)
	return len(p), nil
}

// Feed analyses a buffer of TS packets.
func (a *Analyzer) Feed(b []byte) {
	now := a.now()
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.firstAt.IsZero() {
		a.firstAt = now
		a.lastSample = now
	}
	a.lastAt = now
	a.bytes += int64(len(b))
	for len(b) >= 188 {
		pkt := b[:188]
		b = b[188:]
		if pkt[0] != 0x47 {
			a.syncErrors++
			continue
		}
		a.packets++
		a.packet(pkt, now)
	}
	if now.Sub(a.lastSample) >= time.Second {
		a.win = append(a.win, sample{at: now, bytes: a.bytes, frames: a.videoFrames})
		if len(a.win) > 6 {
			a.win = a.win[len(a.win)-6:]
		}
		a.lastSample = now
	}
}

func (a *Analyzer) packet(p []byte, now time.Time) {
	pusi := p[1]&0x40 != 0
	pid := uint16(p[1]&0x1f)<<8 | uint16(p[2])
	afc := (p[3] >> 4) & 0x3
	cc := p[3] & 0x0f
	if pid == 0x1fff {
		return
	}
	payload := afc&1 == 1
	// continuity: only packets with payload increment CC
	if payload {
		if last, ok := a.lastCC[pid]; ok {
			disc := false
			if afc&2 != 0 && p[4] > 0 && p[5]&0x80 != 0 {
				disc = true // discontinuity_indicator
			}
			if !disc && cc != (last+1)&0x0f && cc != last { // cc==last: allowed duplicate
				a.ccErrors++
			}
		}
		a.lastCC[pid] = cc
	}
	off := 4
	if afc&2 != 0 {
		alen := int(p[4])
		if alen > 0 && 5+alen <= 188 && int(pid) == a.pcrPID && p[5]&0x10 != 0 && alen >= 7 {
			base := int64(p[6])<<25 | int64(p[7])<<17 | int64(p[8])<<9 | int64(p[9])<<1 | int64(p[10]>>7)
			ext := int64(p[10]&1)<<8 | int64(p[11])
			a.pcr(base*300+ext, now)
		}
		off = 5 + alen
	}
	if !payload || off >= 188 {
		return
	}
	data := p[off:]
	switch {
	case pid == 0 && pusi:
		a.pat(data)
	case int(pid) == a.pmtPID && pusi:
		a.pmt(data)
	case int(pid) == a.videoPID && pusi:
		a.videoFrames++
		a.videoPTS(data)
	case int(pid) == a.audioPID && pusi:
		a.audioFrames++
	}
}

// videoPTS tracks contiguous PTS segments; a jump > 2 s (either way) closes one.
func (a *Analyzer) videoPTS(pes []byte) {
	if len(pes) < 14 || pes[0] != 0 || pes[1] != 0 || pes[2] != 1 || pes[7]&0x80 == 0 {
		return
	}
	p := int64(pes[9]&0x0e)<<29 | int64(pes[10])<<22 | int64(pes[11]&0xfe)<<14 | int64(pes[12])<<7 | int64(pes[13])>>1
	const jump = 2 * 90000
	if !a.ptsSeen {
		a.ptsSeen, a.ptsSegStart, a.ptsSegMax = true, p, p
		return
	}
	if p > a.ptsSegMax+jump || p < a.ptsSegStart-jump {
		a.ptsTotal += a.ptsSegMax - a.ptsSegStart
		a.ptsSegStart, a.ptsSegMax = p, p
		a.ptsJumps++
		return
	}
	if p > a.ptsSegMax {
		a.ptsSegMax = p
	}
	if p < a.ptsSegStart {
		a.ptsSegStart = p
	}
}

func (a *Analyzer) pcr(v int64, now time.Time) {
	const hz = 27_000_000
	if a.wall0.IsZero() {
		a.pcr0, a.wall0, a.lastPCR, a.lastPCRAt = v, now, v, now
		return
	}
	d := v - a.lastPCR
	if d < 0 || d > hz { // backwards or > 1 s jump: re-anchor
		a.pcrDisc++
		a.pcr0, a.wall0 = v, now
	} else {
		a.pcrSpan += d
	}
	a.lastPCR, a.lastPCRAt = v, now
	streamMs := float64(v-a.pcr0) / hz * 1000
	wallMs := float64(now.Sub(a.wall0)) / float64(time.Millisecond)
	a.driftMs = streamMs - wallMs
}

func section(data []byte) []byte {
	if len(data) < 1 {
		return nil
	}
	ptr := int(data[0])
	if 1+ptr >= len(data) {
		return nil
	}
	s := data[1+ptr:]
	if len(s) < 3 {
		return nil
	}
	l := int(s[1]&0x0f)<<8 | int(s[2])
	if 3+l > len(s) {
		return nil // section spans packets; tables are tiny, ignore
	}
	return s[:3+l]
}

func (a *Analyzer) pat(data []byte) {
	s := section(data)
	if len(s) < 12 || s[0] != 0 {
		return
	}
	for i := 8; i+4 <= len(s)-4; i += 4 {
		prog := int(s[i])<<8 | int(s[i+1])
		pid := int(s[i+2]&0x1f)<<8 | int(s[i+3])
		if prog != 0 {
			a.pmtPID = pid
			return
		}
	}
}

func (a *Analyzer) pmt(data []byte) {
	s := section(data)
	if len(s) < 16 || s[0] != 2 {
		return
	}
	a.pcrPID = int(s[8]&0x1f)<<8 | int(s[9])
	pil := int(s[10]&0x0f)<<8 | int(s[11])
	i := 12 + pil
	for i+5 <= len(s)-4 {
		st := s[i]
		pid := int(s[i+1]&0x1f)<<8 | int(s[i+2])
		esl := int(s[i+3]&0x0f)<<8 | int(s[i+4])
		switch st {
		case stH264:
			a.videoPID, a.videoCodec = pid, "h264"
		case stH265:
			a.videoPID, a.videoCodec = pid, "h265"
		case stAAC, stAACL:
			a.audioPID, a.audioCodec = pid, "aac"
		}
		i += 5 + esl
	}
}

// Stats returns a snapshot.
func (a *Analyzer) Stats() Stats {
	a.mu.Lock()
	defer a.mu.Unlock()
	s := Stats{Packets: a.packets, Bytes: a.bytes, VideoFrames: a.videoFrames, AudioFrames: a.audioFrames,
		VideoCodec: a.videoCodec, AudioCodec: a.audioCodec, VideoPID: a.videoPID, AudioPID: a.audioPID,
		CCErrors: a.ccErrors, SyncErrors: a.syncErrors, PCRDriftMs: round1(a.driftMs), PCRResets: a.pcrDisc, StreamSeconds: round1(float64(a.pcrSpan) / 27_000_000), VideoSeconds: float64(a.ptsTotal+a.ptsSegMax-a.ptsSegStart) / 90000, PTSJumps: a.ptsJumps,
		FirstPacketAt: a.firstAt, LastPacketAt: a.lastAt}
	if n := len(a.win); n >= 2 {
		first, last := a.win[0], a.win[n-1]
		dt := last.at.Sub(first.at).Seconds()
		if dt > 0 {
			s.BitrateKbps = round1(float64(last.bytes-first.bytes) * 8 / dt / 1000)
			s.FPS = round1(float64(last.frames-first.frames) / dt)
		}
	}
	// stale windows → 0 rates
	if !a.lastAt.IsZero() && a.now().Sub(a.lastAt) > 3*time.Second {
		s.BitrateKbps, s.FPS = 0, 0
	}
	return s
}

func round1(f float64) float64 { return float64(int64(f*10+0.5*sign(f))) / 10 }

func sign(f float64) float64 {
	if f < 0 {
		return -1
	}
	return 1
}
