package scte35

import (
	"bytes"
	"errors"
	"sync"
	"testing"
	"time"
)

const (
	tPMTPID   = 4096
	tVideoPID = 256
	tAudioPID = 257
	tSCTEPID  = 500
)

// tsGen builds a synthetic single-program TS: PAT, PMT (H.264 video with PCR
// on 256, AAC audio on 257), video PES with PTS and PCR, audio PES.
type tsGen struct {
	cc         map[uint16]uint8
	pmtVersion uint8
	videoType  uint8
}

func newGen() *tsGen { return &tsGen{cc: map[uint16]uint8{}, videoType: stH264} }

// packet builds one packet; af (if non-nil) is the adaptation field body
// after its length byte. The payload is padded with 0xFF (PSI) — PES
// packets pass a full-length payload.
func (g *tsGen) packet(pid uint16, pusi bool, af, payload []byte) []byte {
	p := make([]byte, 0, PacketSize)
	b1 := byte(pid>>8) & 0x1F
	if pusi {
		b1 |= 0x40
	}
	afc := byte(0x10)
	if af != nil {
		afc |= 0x20
	}
	p = append(p, syncByte, b1, byte(pid), afc|g.cc[pid])
	g.cc[pid] = (g.cc[pid] + 1) & 0x0F
	if af != nil {
		p = append(p, byte(len(af)))
		p = append(p, af...)
	}
	n := min(len(payload), PacketSize-len(p))
	p = append(p, payload[:n]...)
	for len(p) < PacketSize {
		p = append(p, 0xFF)
	}
	return p
}

func (g *tsGen) psi(pid uint16, section []byte) []byte {
	return g.packet(pid, true, nil, append([]byte{0}, section...))
}

func patSection(pmtPID uint16) []byte {
	s := []byte{0x00, 0xB0, 13, 0x00, 0x01, 0xC1, 0x00, 0x00,
		0x00, 0x01, 0xE0 | byte(pmtPID>>8), byte(pmtPID)}
	return appendCRC(s)
}

func (g *tsGen) pmtSection() []byte {
	es := []byte{
		g.videoType, 0xE0 | tVideoPID>>8, tVideoPID & 0xFF, 0xF0, 0x00,
		0x0F, 0xE0 | tAudioPID>>8, tAudioPID & 0xFF, 0xF0, 0x00,
	}
	secLen := 9 + len(es) + 4
	s := []byte{0x02, 0xB0 | byte(secLen>>8), byte(secLen), 0x00, 0x01, 0xC1 | g.pmtVersion<<1, 0x00, 0x00,
		0xE0 | tVideoPID>>8, tVideoPID & 0xFF, 0xF0, 0x00}
	s = append(s, es...)
	return appendCRC(s)
}

func encPTS(pts uint64) []byte {
	return []byte{
		0x21 | byte(pts>>29)&0x0E,
		byte(pts >> 22),
		byte(pts>>14)&0xFE | 1,
		byte(pts >> 7),
		byte(pts<<1)&0xFE | 1,
	}
}

func pcrAF(base uint64) []byte {
	return []byte{0x10, byte(base >> 25), byte(base >> 17), byte(base >> 9), byte(base >> 1), byte(base&1)<<7 | 0x7E, 0x00}
}

func pes(streamID byte, pts uint64) []byte {
	h := []byte{0, 0, 1, streamID, 0, 0, 0x80, 0x80, 0x05}
	h = append(h, encPTS(pts)...)
	return append(h, bytes.Repeat([]byte{0xAB}, 200)...)
}

// datagram returns 7 packets: [PAT, PMT,] video PUSI (PTS+PCR), video cont,
// audio PES, video cont... .
func (g *tsGen) datagram(pts, pcr uint64, psi bool) []byte {
	var d []byte
	if psi {
		d = append(d, g.psi(0, patSection(tPMTPID))...)
		d = append(d, g.psi(tPMTPID, g.pmtSection())...)
	}
	d = append(d, g.packet(tVideoPID, true, pcrAF(pcr), pes(0xE0, pts))...)
	d = append(d, g.packet(tAudioPID, true, nil, pes(0xC0, pts))...)
	for len(d) < PacketsPerDatagram*PacketSize {
		d = append(d, g.packet(tVideoPID, false, nil, bytes.Repeat([]byte{0xCD}, 184))...)
	}
	return d
}

func packets(b []byte) [][]byte {
	var out [][]byte
	for o := 0; o+PacketSize <= len(b); o += PacketSize {
		out = append(out, b[o:o+PacketSize])
	}
	return out
}

// pmtFrom returns the PMT section found in datagram d.
func pmtFrom(t *testing.T, d []byte) []byte {
	t.Helper()
	for _, p := range packets(d) {
		if pktPID(p) == tPMTPID {
			s, e, ok := singleSection(p, 0x02)
			if !ok {
				t.Fatal("PMT packet without a complete section")
			}
			return p[s:e]
		}
	}
	t.Fatal("no PMT in datagram")
	return nil
}

func TestPMTRewrite(t *testing.T) {
	for _, vt := range []uint8{stH264, stH265} {
		g := newGen()
		g.videoType = vt
		g.pmtVersion = 31 // exercises version wrap-around
		inj := NewInjector(tSCTEPID)
		in := g.datagram(90000, 80000, true)
		orig := append([]byte(nil), in...)
		res := inj.Process(in)
		if !bytes.Equal(in, orig) {
			t.Fatal("Process modified its input")
		}
		if len(res) != 1 || len(res[0]) != len(in) {
			t.Fatalf("got %d datagrams", len(res))
		}
		sec := pmtFrom(t, res[0])
		if CRC32(sec) != 0 {
			t.Fatal("rewritten PMT has a bad CRC")
		}
		pi, ok := parsePMT(sec)
		if !ok {
			t.Fatal("rewritten PMT does not parse")
		}
		if v := sec[5] >> 1 & 0x1F; v != 0 {
			t.Fatalf("version = %d, want 0 (31+1 mod 32)", v)
		}
		if sec[5]&0x01 != 1 {
			t.Fatal("current_next_indicator lost")
		}
		if !pi.hasCUEI {
			t.Fatal("program_info lacks CUEI registration descriptor")
		}
		if pi.videoPID != tVideoPID || pi.pcrPID != tVideoPID {
			t.Fatalf("video/pcr pid %d/%d", pi.videoPID, pi.pcrPID)
		}
		want := []esEntry{{vt, tVideoPID}, {0x0F, tAudioPID}, {StreamTypeSCTE35, tSCTEPID}}
		if len(pi.streams) != len(want) {
			t.Fatalf("streams %+v", pi.streams)
		}
		for k := range want {
			if pi.streams[k] != want[k] {
				t.Fatalf("stream %d = %+v, want %+v", k, pi.streams[k], want[k])
			}
		}
		// The 0x86 entry carries the CUEI registration descriptor.
		if !bytes.Contains(sec[pi.esStart:pi.esEnd], []byte{0x86, 0xE0 | tSCTEPID>>8, tSCTEPID & 0xFF, 0xF0, 0x06, 0x05, 0x04, 'C', 'U', 'E', 'I'}) {
			t.Fatal("0x86 ES entry malformed")
		}
		// Every packet except the PMT is byte-identical (CC/order untouched).
		for k, p := range packets(res[0]) {
			if pktPID(p) == tPMTPID {
				if !bytes.Equal(p[:4], orig[k*PacketSize:k*PacketSize+4]) {
					t.Fatal("PMT packet header (CC) changed")
				}
				continue
			}
			if !bytes.Equal(p, orig[k*PacketSize:(k+1)*PacketSize]) {
				t.Fatalf("packet %d (pid %d) changed", k, pktPID(p))
			}
		}
		if st := inj.Stats(); st.PMTRewritten != 1 || st.LastPTS != 90000 || st.LastPCR != 80000 ||
			st.PMTPID == nil || *st.PMTPID != tPMTPID || st.VideoPID == nil || *st.VideoPID != tVideoPID {
			t.Fatalf("stats %+v", st)
		}
		// Same input version → same output version on every repetition.
		res2 := inj.Process(g.datagram(93000, 83000, true))
		if !bytes.Equal(pmtFrom(t, res2[0])[5:6], sec[5:6]) {
			t.Fatal("version not stable across repetitions")
		}
	}
}

func TestPMTPassThrough(t *testing.T) {
	g := newGen()
	pmt := g.pmtSection()
	badCRC := append([]byte(nil), pmt...)
	badCRC[len(badCRC)-1] ^= 1
	// A PMT that already announces our PID.
	g2 := newGen()
	g2.videoType = StreamTypeSCTE35 // reuse the builder: put 0x86 on PID 256…
	withPID := g2.pmtSection()
	// …and a section_length that claims to continue into the next packet.
	spanning := append([]byte(nil), pmt...)
	spanning[1] = 0xB0 | 0x01
	spanning[2] = 0x00 // 256 bytes

	tests := []struct {
		name string
		sec  []byte
		pid  uint16
	}{
		{"bad crc", badCRC, tSCTEPID},
		{"pid already present", withPID, tVideoPID},
		{"spans packets", spanning, tSCTEPID},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			inj := NewInjector(tc.pid)
			var d []byte
			d = append(d, g.psi(0, patSection(tPMTPID))...)
			d = append(d, g.psi(tPMTPID, tc.sec)...)
			res := inj.Process(d)
			if &res[0][0] != &d[0] || !bytes.Equal(res[0], d) {
				t.Fatal("datagram should pass through unchanged (same slice)")
			}
			if inj.Stats().PMTRewritten != 0 {
				t.Fatal("PMTRewritten counted")
			}
		})
	}
	// Non-188 tail bytes are preserved.
	inj := NewInjector(tSCTEPID)
	d := append(g.datagram(1, 1, true), 0x47, 0x00)
	res := inj.Process(d)
	if len(res[0]) != len(d) || !bytes.Equal(res[0][len(d)-2:], []byte{0x47, 0x00}) {
		t.Fatal("tail bytes lost")
	}
}

func TestInsertBeforePTS(t *testing.T) {
	inj := NewInjector(tSCTEPID)
	if _, err := inj.Insert(Cue{Kind: KindSpliceInsert, OutOfNetwork: true}); err == nil {
		t.Fatal("scheduled cue without PTS must fail")
	}
	if _, err := inj.Insert(Cue{Kind: KindSpliceInsert, OutOfNetwork: true, Immediate: true}); err != nil {
		t.Fatalf("immediate cue: %v", err)
	}
	if _, err := inj.Insert(Cue{Kind: "nope", Immediate: true}); err == nil {
		t.Fatal("unknown kind must fail")
	}
	if _, err := inj.Insert(Cue{Kind: KindSpliceInsert, Immediate: true, DurationMs: -1}); err == nil {
		t.Fatal("negative duration must fail")
	}
}

// cuePackets checks that every extra datagram holds ≤7 SCTE packets and
// returns them in order.
func cuePackets(t *testing.T, res [][]byte) [][]byte {
	t.Helper()
	var out [][]byte
	for _, d := range res[1:] {
		if len(d)%PacketSize != 0 || len(d) == 0 || len(d) > PacketsPerDatagram*PacketSize {
			t.Fatalf("cue datagram of %d bytes", len(d))
		}
		for _, p := range packets(d) {
			if p[0] != syncByte || pktPID(p) != tSCTEPID || p[3]&0x30 != 0x10 {
				t.Fatalf("bad cue packet header % x", p[:4])
			}
			out = append(out, p)
		}
	}
	return out
}

func TestCueInjection(t *testing.T) {
	const pts0 = 1_000_000
	tests := []struct {
		name  string
		cue   Cue
		check func(t *testing.T, sched uint64, in Info)
	}{
		{
			name: "splice_insert out scheduled default preroll",
			cue:  Cue{Kind: KindSpliceInsert, EventID: 1, OutOfNetwork: true, DurationMs: 30000},
			check: func(t *testing.T, sched uint64, in Info) {
				if sched != pts0+4000*90 || in.PTS != sched || !in.OutOfNetwork || in.Duration != 30000*90 || !in.AutoReturn {
					t.Fatalf("sched=%d %+v", sched, in)
				}
			},
		},
		{
			name: "splice_insert in with 2s preroll",
			cue:  Cue{Kind: KindSpliceInsert, EventID: 1, PreRollMs: 2000},
			check: func(t *testing.T, sched uint64, in Info) {
				if sched != pts0+2000*90 || in.PTS != sched || in.OutOfNetwork || in.HasDuration {
					t.Fatalf("sched=%d %+v", sched, in)
				}
			},
		},
		{
			name: "splice_insert immediate",
			cue:  Cue{Kind: KindSpliceInsert, EventID: 2, OutOfNetwork: true, Immediate: true},
			check: func(t *testing.T, _ uint64, in Info) {
				if !in.Immediate || in.TimeSpecified || in.EventID != 2 {
					t.Fatalf("%+v", in)
				}
			},
		},
		{
			name: "time_signal 0x34",
			cue:  Cue{Kind: KindTimeSignal, EventID: 3, SegmentationTypeID: 0x34, DurationMs: 15000},
			check: func(t *testing.T, sched uint64, in Info) {
				if in.CommandType != CmdTimeSignal || in.PTS != sched || len(in.Segmentations) != 1 ||
					in.Segmentations[0].TypeID != 0x34 || in.Segmentations[0].Duration != 15000*90 {
					t.Fatalf("%+v", in)
				}
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			g := newGen()
			inj := NewInjector(tSCTEPID)
			first := inj.Process(g.datagram(pts0, pts0-9000, true))
			if len(first) != 1 {
				t.Fatal("no cue expected yet")
			}
			sched, err := inj.Insert(tc.cue)
			if err != nil {
				t.Fatal(err)
			}
			if st := inj.Stats(); st.Pending != 1 || st.CuesSent != 0 {
				t.Fatalf("stats %+v", st)
			}
			in := g.datagram(pts0+3000, pts0-6000, false)
			orig := append([]byte(nil), in...)
			res := inj.Process(in)
			if len(res) != 2 || !bytes.Equal(res[0], orig) {
				t.Fatalf("want input + 1 cue datagram, got %d", len(res))
			}
			cp := cuePackets(t, res)
			if len(cp) != 1 {
				t.Fatalf("%d cue packets", len(cp))
			}
			p := cp[0]
			if !pktPUSI(p) || p[3]&0x0F != 0 || p[4] != 0 {
				t.Fatalf("cue packet header % x", p[:5])
			}
			info, err := Parse(p[5:])
			if err != nil {
				t.Fatal(err)
			}
			tc.check(t, sched, info)
			// Stuffing after the section.
			end := 5 + 3 + (int(p[6]&0x0F)<<8 | int(p[7]))
			for _, b := range p[end:] {
				if b != 0xFF {
					t.Fatal("non-0xFF stuffing")
				}
			}
			st := inj.Stats()
			if st.CuesSent != 1 || st.Pending != 0 || st.LastCue == nil || st.LastCue.EventID != tc.cue.EventID || st.LastCuePTS != sched {
				t.Fatalf("stats %+v", st)
			}
			// Nothing more on the next datagram.
			if len(inj.Process(g.datagram(pts0+6000, pts0-3000, false))) != 1 {
				t.Fatal("cue re-emitted")
			}
		})
	}
}

func TestCueContinuityAndBatching(t *testing.T) {
	g := newGen()
	inj := NewInjector(tSCTEPID)
	var all []byte
	collect := func(res [][]byte) {
		for _, d := range res {
			all = append(all, d...)
		}
	}
	collect(inj.Process(g.datagram(500_000, 490_000, true)))

	// 9 cues queued before one Process → 9 packets → datagrams of 7 + 2.
	for k := range 9 {
		if _, err := inj.Insert(Cue{Kind: KindSpliceInsert, EventID: uint32(100 + k), OutOfNetwork: k%2 == 0}); err != nil {
			t.Fatal(err)
		}
	}
	res := inj.Process(g.datagram(503_000, 493_000, false))
	if len(res) != 3 || len(res[1]) != 7*PacketSize || len(res[2]) != 2*PacketSize {
		t.Fatalf("datagram sizes: %d", len(res))
	}
	collect(res)
	// Then 10 more one by one: CC keeps counting and wraps past 15.
	for k := range 10 {
		if _, err := inj.Insert(Cue{Kind: KindTimeSignal, EventID: uint32(200 + k), Immediate: true}); err != nil {
			t.Fatal(err)
		}
		collect(inj.Process(g.datagram(uint64(506_000+3000*k), uint64(496_000+3000*k), k%3 == 0)))
	}

	// CC is consecutive on every PID, SCTE included; cues follow their input.
	lastCC := map[uint16]int{}
	var scteCount int
	for _, p := range packets(all) {
		pid := pktPID(p)
		cc := int(p[3] & 0x0F)
		if prev, ok := lastCC[pid]; ok && cc != (prev+1)&0x0F {
			t.Fatalf("pid %d: CC %d after %d", pid, cc, prev)
		}
		lastCC[pid] = cc
		if pid == tSCTEPID {
			scteCount++
		}
	}
	if scteCount != 19 {
		t.Fatalf("%d SCTE packets, want 19", scteCount)
	}

	// ExtractSections sees the 0x86 PID from the rewritten PMT and decodes all.
	infos, err := ExtractSections(all)
	if err != nil {
		t.Fatal(err)
	}
	if len(infos) != 19 {
		t.Fatalf("extracted %d sections", len(infos))
	}
	for k, in := range infos {
		ok := in.PID == tSCTEPID
		if k < 9 {
			ok = ok && in.CommandType == CmdSpliceInsert && in.EventID == uint32(100+k) && in.OutOfNetwork == (k%2 == 0)
		} else {
			ok = ok && in.CommandType == CmdTimeSignal && !in.TimeSpecified
		}
		if !ok {
			t.Fatalf("section %d: %+v", k, in)
		}
	}
	if inj.Stats().CuesSent != 19 {
		t.Fatalf("stats %+v", inj.Stats())
	}
}

func TestPacketizeMultiPacketSection(t *testing.T) {
	// A 400-byte section (only reachable via descriptors) spans 3 packets.
	body := bytes.Repeat([]byte{0x00, 0x08, 'C', 'U', 'E', 'I', 0, 0, 0, 1}, 38) // avail descriptors
	sec := buildSection(CmdSpliceNull, nil, body)
	var cc uint8 = 14
	pk := packetize(nil, sec, tSCTEPID, &cc)
	ps := packets(pk)
	if len(ps) != 3 || cc != 1 {
		t.Fatalf("%d packets, cc=%d", len(ps), cc)
	}
	if !pktPUSI(ps[0]) || pktPUSI(ps[1]) || pktPUSI(ps[2]) {
		t.Fatal("PUSI only on the first packet")
	}
	g := newGen()
	// The cue precedes the PMT: ExtractSections must resolve PIDs first.
	inj := NewInjector(tSCTEPID)
	stream := append([]byte(nil), inj.Process(g.psi(0, patSection(tPMTPID)))[0]...)
	stream = append(stream, pk...)
	stream = append(stream, inj.Process(g.psi(tPMTPID, g.pmtSection()))[0]...)
	infos, err := ExtractSections(append([]byte{0x00, 0x01, 0x02}, stream...)) // unaligned start
	if err != nil {
		t.Fatal(err)
	}
	if len(infos) != 1 || len(infos[0].Descriptors) != 38 {
		t.Fatalf("infos %+v", infos)
	}
}

func TestExtractSectionsErrors(t *testing.T) {
	if _, err := ExtractSections(make([]byte, 3*PacketSize)); !errors.Is(err, ErrNoPMT) {
		t.Fatalf("err = %v", err)
	}
	// A corrupted cue is reported but does not hide the good one.
	g := newGen()
	inj := NewInjector(tSCTEPID)
	s := inj.Process(g.datagram(1000, 900, true))[0]
	_, _ = inj.Insert(Cue{Kind: KindSpliceNull})
	r1 := inj.Process(g.datagram(4000, 3900, false))
	_, _ = inj.Insert(Cue{Kind: KindSpliceInsert, EventID: 9, Immediate: true})
	r2 := inj.Process(g.datagram(7000, 6900, false))
	bad := append([]byte(nil), r1[1]...)
	bad[10] ^= 0xFF
	stream := append(append(append(append(s, r1[0]...), bad...), r2[0]...), r2[1]...)
	infos, err := ExtractSections(stream)
	if !errors.Is(err, ErrCRC) || len(infos) != 1 || infos[0].EventID != 9 {
		t.Fatalf("infos=%+v err=%v", infos, err)
	}
}

func TestHeartbeat(t *testing.T) {
	g := newGen()
	inj := NewInjector(tSCTEPID)
	inj.SetHeartbeat(time.Second)
	var nulls int
	for k := range 9 { // PCR advances 0.5 s per datagram: 0 … 4 s
		pcr := uint64(k) * 45000
		res := inj.Process(g.datagram(pcr+9000, pcr, k == 0))
		for _, p := range cuePackets(t, res) {
			in, err := Parse(p[5:])
			if err != nil || in.CommandType != CmdSpliceNull {
				t.Fatalf("heartbeat %+v %v", in, err)
			}
			nulls++
		}
	}
	if nulls != 4 {
		t.Fatalf("%d heartbeats in 4 s, want 4", nulls)
	}
	if st := inj.Stats(); st.HeartbeatsSent != 4 || st.CuesSent != 0 {
		t.Fatalf("stats %+v", st)
	}
	inj.SetHeartbeat(0)
	for k := range 6 {
		pcr := uint64(9+k) * 45000
		if len(inj.Process(g.datagram(pcr+9000, pcr, false))) != 1 {
			t.Fatal("heartbeat after disable")
		}
	}
}

func TestPTSTracking(t *testing.T) {
	tests := []struct {
		name string
		seq  []uint64
		want uint64
	}{
		{"forward", []uint64{1000, 4000, 7000}, 7000},
		{"b-frame reorder ignored", []uint64{10000, 19000, 13000, 16000}, 19000},
		{"discontinuity followed", []uint64{50 * 90000, 1000}, 1000},
		{"wrap", []uint64{mask33 - 1000, 2000}, 2000},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			g := newGen()
			inj := NewInjector(tSCTEPID)
			for k, pts := range tc.seq {
				inj.Process(g.datagram(pts, uint64(k), k == 0))
			}
			if got := inj.Stats().LastPTS; got != tc.want {
				t.Fatalf("LastPTS = %d, want %d", got, tc.want)
			}
		})
	}
	// Scheduled PTS wraps mod 2^33.
	g := newGen()
	inj := NewInjector(tSCTEPID)
	inj.Process(g.datagram(mask33-90000, 0, true))
	sched, err := inj.Insert(Cue{Kind: KindTimeSignal, PreRollMs: 4000})
	if err != nil || sched != 4000*90-90000-1 {
		t.Fatalf("sched=%d err=%v", sched, err)
	}
}

func TestConcurrentInsertStats(t *testing.T) {
	g := newGen()
	inj := NewInjector(tSCTEPID)
	inj.SetHeartbeat(100 * time.Millisecond)
	dgrams := make([][]byte, 200)
	for k := range dgrams {
		dgrams[k] = g.datagram(uint64(k)*3000, uint64(k)*3000, k%10 == 0)
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for range 100 {
			_, _ = inj.Insert(Cue{Kind: KindSpliceInsert, Immediate: true})
			_ = inj.Stats()
		}
	}()
	go func() {
		defer wg.Done()
		for _, d := range dgrams {
			inj.Process(d)
		}
	}()
	wg.Wait()
	inj.Process(g.datagram(1, 1, false)) // flush leftovers
	st := inj.Stats()
	if st.CuesSent != 100 || st.Pending != 0 {
		t.Fatalf("stats %+v", st)
	}
}
