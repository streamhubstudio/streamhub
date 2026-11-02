// Package scte35 inserts SCTE-35 (ANSI/SCTE 35 2022) splice cues into the
// encoder's MPEG-TS by rewriting it in Go, datagram by datagram, between the
// GStreamer engine (which cannot take runtime events) and the outputs.
//
// The Injector:
//   - follows PAT → PMT, and rewrites every single-packet PMT section to
//     announce an elementary stream of stream_type 0x86 on the configured PID
//     with a "CUEI" registration descriptor (plus a CUEI registration
//     descriptor in program_info), version_number = input version + 1,
//     section_length and CRC-32/MPEG-2 recomputed;
//   - tracks the latest video PTS (first H.264/HEVC stream of the PMT) and
//     the PCR (PMT PCR_PID);
//   - emits queued cues as splice_info_section packets on that PID, in extra
//     datagrams (≤ 7 packets each) appended after the input datagram;
//   - optionally emits a splice_null() heartbeat every N seconds of stream
//     (PCR) time.
//
// Parse / ExtractSections decode sections for tests and stream analysis.
package scte35

import (
	"fmt"
	"sync"
	"time"
)

// PacketsPerDatagram is the maximum number of TS packets per emitted cue
// datagram (7×188 = 1316 bytes, the usual TS-over-UDP payload).
const PacketsPerDatagram = 7

// Injector rewrites one program's MPEG-TS to carry SCTE-35 cues on a PID.
// Process must be called from a single goroutine; Insert, Stats and
// SetHeartbeat are safe to call concurrently with it.
type Injector struct {
	pid uint16

	mu sync.Mutex
	cc uint8 // continuity counter of the SCTE-35 PID

	pmtPID   uint16
	havePMT  bool // pmtPID known (from the PAT)
	videoPID uint16
	pcrPID   uint16
	haveES   bool // videoPID/pcrPID known (from the PMT)

	havePTS bool
	lastPTS uint64
	havePCR bool
	lastPCR uint64

	hbTicks uint64 // heartbeat interval in 90 kHz ticks; 0 = off
	hbArmed bool
	hbLast  uint64

	pending []pendingSection

	cuesSent       int64
	heartbeatsSent int64
	pmtRewritten   int64
	lastCue        *Cue
	lastCuePTS     uint64
}

type pendingSection struct {
	section []byte
	cue     *Cue   // nil for a heartbeat
	pts     uint64 // scheduled PTS of cue
}

// NewInjector returns an injector that carries SCTE-35 on pid (e.g. 500).
// The heartbeat is off; enable it with SetHeartbeat.
func NewInjector(pid uint16) *Injector {
	return &Injector{pid: pid & 0x1FFF}
}

// PID returns the SCTE-35 PID.
func (i *Injector) PID() uint16 { return i.pid }

// SetHeartbeat makes Process emit a splice_null() every d of stream time
// (measured on the PCR). d <= 0 disables it.
func (i *Injector) SetHeartbeat(d time.Duration) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if d <= 0 {
		i.hbTicks = 0
	} else {
		i.hbTicks = max(uint64(d.Microseconds())*9/100, 1)
	}
	i.hbArmed = false
}

// Insert queues c; it is emitted by the next Process call. For a scheduled
// (non-immediate) splice_insert/time_signal the splice time is the last video
// PTS + PreRollMs (0 → DefaultPreRollMs) and is returned; it fails if no
// video PTS has been seen yet. Immediate cues and splice_null return the last
// video PTS seen (0 if none) for information only.
func (i *Injector) Insert(c Cue) (scheduledPTS uint64, err error) {
	switch c.Kind {
	case KindSpliceInsert, KindTimeSignal, KindSpliceNull:
	default:
		return 0, fmt.Errorf("scte35: unknown cue kind %q (want splice_insert, time_signal or splice_null)", c.Kind)
	}
	if c.PreRollMs < 0 || c.DurationMs < 0 {
		return 0, fmt.Errorf("scte35: preRollMs and durationMs must be >= 0")
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	pts := i.lastPTS
	if c.Kind != KindSpliceNull && !c.Immediate {
		if !i.havePTS {
			return 0, fmt.Errorf("scte35: no video PTS seen yet; use an immediate cue or retry")
		}
		pre := c.PreRollMs
		if pre == 0 {
			pre = DefaultPreRollMs
		}
		pts = (i.lastPTS + msToTicks(pre)) & mask33
	}
	sec, err := Encode(c, pts)
	if err != nil {
		return 0, err
	}
	cc := c
	i.pending = append(i.pending, pendingSection{section: sec, cue: &cc, pts: pts})
	return pts, nil
}

// Stats is a snapshot of the injector state.
type Stats struct {
	CuesSent       int64   `json:"cuesSent"`
	HeartbeatsSent int64   `json:"heartbeatsSent"`
	Pending        int     `json:"pending"`
	LastCue        *Cue    `json:"lastCue,omitempty"`
	LastCuePTS     uint64  `json:"lastCuePts,omitempty"`
	LastPTS        uint64  `json:"lastPts"`
	LastPCR        uint64  `json:"lastPcr"` // 33-bit base, 90 kHz
	PMTRewritten   int64   `json:"pmtRewritten"`
	PMTPID         *uint16 `json:"pmtPid,omitempty"`
	VideoPID       *uint16 `json:"videoPid,omitempty"`
}

// Stats returns a snapshot.
func (i *Injector) Stats() Stats {
	i.mu.Lock()
	defer i.mu.Unlock()
	s := Stats{
		CuesSent:       i.cuesSent,
		HeartbeatsSent: i.heartbeatsSent,
		Pending:        len(i.pending),
		LastCuePTS:     i.lastCuePTS,
		LastPTS:        i.lastPTS,
		LastPCR:        i.lastPCR,
		PMTRewritten:   i.pmtRewritten,
	}
	if i.lastCue != nil {
		c := *i.lastCue
		s.LastCue = &c
	}
	if i.havePMT {
		v := i.pmtPID
		s.PMTPID = &v
	}
	if i.haveES && i.videoPID != 0 {
		v := i.videoPID
		s.VideoPID = &v
	}
	return s
}

// Process takes one datagram (n×188 bytes; a trailing partial packet is
// passed through untouched) and returns the datagram(s) to send instead:
// first the input — the same slice when nothing changed, otherwise a copy
// with the PMT packet(s) rewritten (the input is never modified) — followed
// by zero or more datagrams of ≤ 7 SCTE-35 packets for the cues (and
// heartbeat) due now. Packets of every other PID keep their bytes and order.
func (i *Injector) Process(dgram []byte) [][]byte {
	i.mu.Lock()
	defer i.mu.Unlock()

	out := dgram
	copied := false
	for off := 0; off+PacketSize <= len(dgram); off += PacketSize {
		p := dgram[off : off+PacketSize]
		if p[0] != syncByte || p[1]&0x80 != 0 { // lost sync / transport_error
			continue
		}
		pid := pktPID(p)
		switch {
		case pid == 0:
			i.onPAT(p)
		case i.havePMT && pid == i.pmtPID:
			if np := i.onPMT(p); np != nil {
				if !copied {
					out = append([]byte(nil), dgram...)
					copied = true
				}
				copy(out[off:], np)
			}
		}
		if !i.haveES {
			continue
		}
		if pid == i.pcrPID {
			if v, ok := pcrBase(p); ok {
				i.onPCR(v)
			}
		}
		if pid == i.videoPID && pktPUSI(p) {
			if po, ok := payloadOffset(p); ok {
				if v, ok := pesPTS(p[po:]); ok {
					i.onPTS(v)
				}
			}
		}
	}

	res := [][]byte{out}
	if len(i.pending) > 0 {
		res = append(res, i.flush()...)
	}
	return res
}

func (i *Injector) onPAT(p []byte) {
	s, e, ok := singleSection(p, 0x00)
	if !ok {
		return
	}
	v, ok := parsePAT(p[s:e])
	if !ok {
		return
	}
	if !i.havePMT || v != i.pmtPID {
		i.pmtPID, i.havePMT = v, true
		i.haveES = false // re-learn video/PCR PIDs from the new PMT
	}
}

// onPMT learns the video/PCR PIDs and returns the rewritten packet (or nil to
// pass p through).
func (i *Injector) onPMT(p []byte) []byte {
	np, pi, valid := rewritePMT(p, i.pid)
	if !valid {
		return nil
	}
	if !i.haveES || pi.videoPID != i.videoPID || pi.pcrPID != i.pcrPID {
		i.videoPID, i.pcrPID, i.haveES = pi.videoPID, pi.pcrPID, true
		i.havePTS, i.havePCR, i.hbArmed = false, false, false
	}
	if np != nil {
		i.pmtRewritten++
	}
	return np
}

// onPTS keeps the "latest" video PTS: it moves forward (mod 2^33) and ignores
// small backward steps caused by B-frame reordering, but follows a backward
// jump of more than 10 s (stream discontinuity/restart).
func (i *Injector) onPTS(v uint64) {
	const reorderWindow = 10 * 90000
	if !i.havePTS {
		i.lastPTS, i.havePTS = v, true
		return
	}
	d := (v - i.lastPTS) & mask33
	if d < 1<<32 || (1<<33)-d > reorderWindow {
		i.lastPTS = v
	}
}

func (i *Injector) onPCR(v uint64) {
	i.lastPCR, i.havePCR = v, true
	if i.hbTicks == 0 {
		return
	}
	if !i.hbArmed {
		i.hbArmed, i.hbLast = true, v
		return
	}
	// Elapsed time mod 2^33; a backward PCR jump shows up as huge and simply
	// fires once and re-arms.
	if (v-i.hbLast)&mask33 >= i.hbTicks {
		i.hbLast = v
		sec, _ := Encode(Cue{Kind: KindSpliceNull}, 0)
		i.pending = append(i.pending, pendingSection{section: sec})
	}
}

// flush packetizes every pending section and splits the packets into
// datagrams of ≤ PacketsPerDatagram packets.
func (i *Injector) flush() [][]byte {
	var buf []byte
	for _, ps := range i.pending {
		buf = packetize(buf, ps.section, i.pid, &i.cc)
		if ps.cue != nil {
			i.cuesSent++
			i.lastCue, i.lastCuePTS = ps.cue, ps.pts
		} else {
			i.heartbeatsSent++
		}
	}
	i.pending = i.pending[:0]
	const chunk = PacketsPerDatagram * PacketSize
	var res [][]byte
	for len(buf) > 0 {
		n := min(len(buf), chunk)
		res = append(res, buf[:n:n])
		buf = buf[n:]
	}
	return res
}
