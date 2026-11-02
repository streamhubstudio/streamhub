package scte35

import (
	"errors"
	"fmt"
)

// MPEG-TS constants.
const (
	PacketSize = 188
	syncByte   = 0x47
	// StreamTypeSCTE35 is the PMT stream_type for SCTE-35 splice sections.
	StreamTypeSCTE35 = 0x86
	stH264           = 0x1b
	stH265           = 0x24
)

// ErrNoPMT is returned by ExtractSections when no PAT/PMT could be parsed.
var ErrNoPMT = errors.New("scte35: no PAT/PMT found in transport stream")

func pktPID(p []byte) uint16 { return uint16(p[1]&0x1F)<<8 | uint16(p[2]) }
func pktPUSI(p []byte) bool  { return p[1]&0x40 != 0 }

// payloadOffset returns the offset of the payload inside a 188-byte packet,
// or ok=false when the packet carries no (valid) payload.
func payloadOffset(p []byte) (int, bool) {
	afc := p[3] >> 4 & 0x03
	if afc&0x01 == 0 {
		return 0, false
	}
	off := 4
	if afc&0x02 != 0 {
		off += 1 + int(p[4])
	}
	if off >= PacketSize {
		return 0, false
	}
	return off, true
}

// pcrBase returns the 33-bit PCR base of a packet whose adaptation field
// carries a PCR.
func pcrBase(p []byte) (uint64, bool) {
	if p[3]&0x20 == 0 || p[4] < 7 || p[5]&0x10 == 0 {
		return 0, false
	}
	return uint64(p[6])<<25 | uint64(p[7])<<17 | uint64(p[8])<<9 | uint64(p[9])<<1 | uint64(p[10]>>7), true
}

// pesPTS returns the PTS of a PES packet header starting at payload b.
func pesPTS(b []byte) (uint64, bool) {
	if len(b) < 14 || b[0] != 0 || b[1] != 0 || b[2] != 1 {
		return 0, false
	}
	if b[6]&0xC0 != 0x80 || b[7]&0x80 == 0 { // no optional header / no PTS
		return 0, false
	}
	t := b[9:14]
	return uint64(t[0]>>1&0x07)<<30 | uint64(t[1])<<22 | uint64(t[2]>>1)<<15 | uint64(t[3])<<7 | uint64(t[4]>>1), true
}

// singleSection locates a PSI section that starts in this packet
// (payload_unit_start, pointer_field) and ends inside it. It returns the
// section's bounds within p; ok=false when the packet does not start a
// section of tid or the section spans into the next packet.
func singleSection(p []byte, tid byte) (start, end int, ok bool) {
	if !pktPUSI(p) {
		return 0, 0, false
	}
	off, okp := payloadOffset(p)
	if !okp {
		return 0, 0, false
	}
	start = off + 1 + int(p[off])
	if start+3 > PacketSize || p[start] != tid {
		return 0, 0, false
	}
	end = start + 3 + (int(p[start+1]&0x0F)<<8 | int(p[start+2]))
	if end > PacketSize {
		return 0, 0, false
	}
	return start, end, true
}

// parsePAT returns the PMT PID of the first program in a PAT section.
func parsePAT(sec []byte) (uint16, bool) {
	if len(sec) < 12 || sec[0] != 0x00 || CRC32(sec) != 0 {
		return 0, false
	}
	for p := 8; p+4 <= len(sec)-4; p += 4 {
		prog := uint16(sec[p])<<8 | uint16(sec[p+1])
		if prog != 0 { // 0 = network PID
			return uint16(sec[p+2]&0x1F)<<8 | uint16(sec[p+3]), true
		}
	}
	return 0, false
}

// esEntry is one elementary-stream loop entry of a PMT.
type esEntry struct {
	streamType uint8
	pid        uint16
}

// pmtInfo is what the injector needs from a PMT section.
type pmtInfo struct {
	pcrPID   uint16
	videoPID uint16 // 0 = none
	streams  []esEntry
	// offsets inside the section
	piLen, esStart, esEnd int
	hasCUEI               bool // program_info already has a CUEI registration descriptor
}

// parsePMT validates (CRC included) and walks a PMT section.
func parsePMT(sec []byte) (pmtInfo, bool) {
	var pi pmtInfo
	if len(sec) < 16 || sec[0] != 0x02 || CRC32(sec) != 0 {
		return pi, false
	}
	pi.pcrPID = uint16(sec[8]&0x1F)<<8 | uint16(sec[9])
	pi.piLen = int(sec[10]&0x0F)<<8 | int(sec[11])
	pi.esStart = 12 + pi.piLen
	pi.esEnd = len(sec) - 4
	if pi.esStart > pi.esEnd {
		return pi, false
	}
	for d := sec[12:pi.esStart]; len(d) >= 2; {
		l := int(d[1])
		if 2+l > len(d) {
			return pi, false
		}
		if d[0] == 0x05 && l >= 4 && string(d[2:6]) == "CUEI" {
			pi.hasCUEI = true
		}
		d = d[2+l:]
	}
	p := pi.esStart
	for p+5 <= pi.esEnd {
		e := esEntry{streamType: sec[p], pid: uint16(sec[p+1]&0x1F)<<8 | uint16(sec[p+2])}
		pi.streams = append(pi.streams, e)
		if pi.videoPID == 0 && (e.streamType == stH264 || e.streamType == stH265) {
			pi.videoPID = e.pid
		}
		p += 5 + (int(sec[p+3]&0x0F)<<8 | int(sec[p+4]))
	}
	if p != pi.esEnd {
		return pi, false
	}
	return pi, true
}

// rewritePMT returns a copy of PMT packet p whose section announces the
// SCTE-35 stream on pid (stream_type 0x86 + CUEI registration descriptor in
// both program_info and the ES loop), with version_number = input+1 (mod 32)
// so receivers re-parse, and fresh section_length/CRC. It returns nil when p
// must pass through unchanged: not a section start, section spanning
// packets, bad CRC, pid already present, foreign data after the section, or
// result would not fit in the packet. The parsed PMT is returned whenever the
// section was valid.
func rewritePMT(p []byte, pid uint16) ([]byte, pmtInfo, bool) {
	start, end, ok := singleSection(p, 0x02)
	if !ok {
		return nil, pmtInfo{}, false
	}
	sec := p[start:end]
	pi, ok := parsePMT(sec)
	if !ok {
		return nil, pi, false
	}
	for _, e := range pi.streams {
		if e.pid == pid {
			return nil, pi, true
		}
	}
	for _, b := range p[end:] {
		if b != 0xFF { // another section follows: don't risk corrupting it
			return nil, pi, true
		}
	}

	ns := make([]byte, 0, len(sec)+17)
	ns = append(ns, sec[:12]...)
	ns = append(ns, sec[12:pi.esStart]...)
	piLen := pi.piLen
	if !pi.hasCUEI {
		ns = append(ns, 0x05, 0x04, 'C', 'U', 'E', 'I')
		piLen += 6
	}
	ns = append(ns, sec[pi.esStart:pi.esEnd]...)
	ns = append(ns, StreamTypeSCTE35, 0xE0|byte(pid>>8)&0x1F, byte(pid), 0xF0, 0x06, 0x05, 0x04, 'C', 'U', 'E', 'I')
	secLen := len(ns) - 3 + 4
	ns[1] = sec[1]&0xF0 | byte(secLen>>8)&0x0F
	ns[2] = byte(secLen)
	version := (sec[5]>>1 + 1) & 0x1F
	ns[5] = sec[5]&0xC1 | version<<1 // keep reserved + current_next_indicator
	ns[10] = sec[10]&0xF0 | byte(piLen>>8)&0x0F
	ns[11] = byte(piLen)
	ns = appendCRC(ns)
	// Rebuild the packet: header, the adaptation field only if it carries
	// more than stuffing (mpegtsmux pads PSI packets with adaptation-field
	// stuffing in front of the section), pointer_field 0, section, 0xFF.
	off, _ := payloadOffset(p)
	np := make([]byte, PacketSize)
	copy(np, p[:4])
	pos := 4
	if off > 5 && p[5] != 0 { // adaptation field with flags (e.g. PCR): keep it
		copy(np[4:off], p[4:off])
		pos = off
	} else {
		np[3] = np[3]&0xCF | 0x10 // payload only
	}
	if pos+1+len(ns) > PacketSize {
		return nil, pi, true
	}
	np[pos] = 0 // pointer_field
	n := copy(np[pos+1:], ns)
	for k := pos + 1 + n; k < PacketSize; k++ {
		np[k] = 0xFF
	}
	return np, pi, true
}

// packetize appends to dst the TS packets carrying section on pid:
// payload_unit_start + pointer_field 0 on the first packet, payload-only
// packets, continuity counter from *cc (advanced), 0xFF stuffing.
func packetize(dst, section []byte, pid uint16, cc *uint8) []byte {
	payload := make([]byte, 0, 1+len(section))
	payload = append(payload, 0x00) // pointer_field
	payload = append(payload, section...)
	for first := true; len(payload) > 0; first = false {
		var h [4]byte
		h[0] = syncByte
		h[1] = byte(pid>>8) & 0x1F
		if first {
			h[1] |= 0x40
		}
		h[2] = byte(pid)
		h[3] = 0x10 | *cc&0x0F
		*cc = (*cc + 1) & 0x0F
		dst = append(dst, h[:]...)
		n := min(len(payload), PacketSize-4)
		dst = append(dst, payload[:n]...)
		payload = payload[n:]
		for k := n; k < PacketSize-4; k++ {
			dst = append(dst, 0xFF)
		}
	}
	return dst
}

// syncOffset finds the first offset at which two consecutive sync bytes line
// up (tolerates a capture that does not start on a packet boundary).
func syncOffset(ts []byte) int {
	for o := 0; o < PacketSize && o < len(ts); o++ {
		if ts[o] != syncByte {
			continue
		}
		if o+PacketSize >= len(ts) || ts[o+PacketSize] == syncByte {
			return o
		}
	}
	return 0
}

// ExtractSections scans a TS byte stream (any length, packets need not start
// at offset 0) and decodes every SCTE-35 section carried on the PID(s)
// announced with stream_type 0x86 in the PMT. Sections may span packets.
// It returns ErrNoPMT when no valid PAT+PMT is found; sections that fail to
// decode are skipped and reported in a joined error alongside the good ones.
func ExtractSections(ts []byte) ([]Info, error) {
	start := syncOffset(ts)
	var pkts [][]byte
	for o := start; o+PacketSize <= len(ts); o += PacketSize {
		if p := ts[o : o+PacketSize]; p[0] == syncByte && p[1]&0x80 == 0 {
			pkts = append(pkts, p)
		}
	}

	// Pass 1: PAT → PMT → SCTE-35 PIDs (the PMT may come after the first cue).
	pmtPID, havePMTPID := uint16(0), false
	for _, p := range pkts {
		if pktPID(p) == 0 {
			if s, e, ok := singleSection(p, 0x00); ok {
				if v, ok := parsePAT(p[s:e]); ok {
					pmtPID, havePMTPID = v, true
					break
				}
			}
		}
	}
	scte := map[uint16]bool{}
	gotPMT := false
	if havePMTPID {
		for _, p := range pkts {
			if pktPID(p) != pmtPID {
				continue
			}
			s, e, ok := singleSection(p, 0x02)
			if !ok {
				continue
			}
			if pi, ok := parsePMT(p[s:e]); ok {
				gotPMT = true
				for _, es := range pi.streams {
					if es.streamType == StreamTypeSCTE35 {
						scte[es.pid] = true
					}
				}
			}
		}
	}
	if !gotPMT {
		return nil, ErrNoPMT
	}

	// Pass 2: reassemble sections on those PIDs.
	type asm struct {
		buf    []byte
		active bool
		cc     int
	}
	state := map[uint16]*asm{}
	var out []Info
	var errs []error
	emit := func(pid uint16, a *asm) {
		for len(a.buf) > 0 && a.buf[0] != 0xFF {
			if len(a.buf) < 3 {
				return // header split across packets
			}
			total := 3 + (int(a.buf[1]&0x0F)<<8 | int(a.buf[2]))
			if len(a.buf) < total {
				return // wait for the continuation packets
			}
			in, err := Parse(a.buf[:total])
			if err != nil {
				errs = append(errs, fmt.Errorf("pid %d: %w", pid, err))
			} else {
				in.PID = pid
				out = append(out, in)
			}
			a.buf = a.buf[total:]
		}
		a.buf, a.active = a.buf[:0], false // rest is stuffing
	}
	for _, p := range pkts {
		pid := pktPID(p)
		if !scte[pid] {
			continue
		}
		off, ok := payloadOffset(p)
		if !ok {
			continue
		}
		a := state[pid]
		if a == nil {
			a = &asm{cc: -1}
			state[pid] = a
		}
		cc := int(p[3] & 0x0F)
		if a.cc >= 0 && cc != (a.cc+1)&0x0F {
			a.buf, a.active = a.buf[:0], false // discontinuity: drop partial
		}
		a.cc = cc
		pl := p[off:]
		if pktPUSI(p) {
			ptr := int(pl[0])
			if 1+ptr > len(pl) {
				a.buf, a.active = a.buf[:0], false
				continue
			}
			if a.active {
				a.buf = append(a.buf, pl[1:1+ptr]...)
				emit(pid, a)
			}
			a.buf = append(a.buf[:0], pl[1+ptr:]...)
			a.active = true
			emit(pid, a)
			// emit clears active only when the tail was stuffing/complete;
			// a partial section keeps accumulating.
			continue
		}
		if a.active {
			a.buf = append(a.buf, pl...)
			emit(pid, a)
		}
	}
	return out, errors.Join(errs...)
}
