package tsbus

import (
	"bytes"
	"net"
	"testing"
	"time"
)

// tiny TS writer for tests ---------------------------------------------------

type tsw struct{ cc map[int]byte }

func newTSW() *tsw { return &tsw{cc: map[int]byte{}} }

func (w *tsw) pkt(pid int, pusi bool, payload []byte, pcr int64) []byte {
	p := make([]byte, 188)
	p[0] = 0x47
	p[1] = byte(pid>>8) & 0x1f
	if pusi {
		p[1] |= 0x40
	}
	p[2] = byte(pid)
	off := 4
	afc := byte(1)
	if pcr >= 0 {
		afc = 3
		p[4] = 7
		p[5] = 0x10
		base, ext := pcr/300, pcr%300
		p[6] = byte(base >> 25)
		p[7] = byte(base >> 17)
		p[8] = byte(base >> 9)
		p[9] = byte(base >> 1)
		p[10] = byte(base<<7) | 0x7e | byte(ext>>8)
		p[11] = byte(ext)
		off = 12
	}
	p[3] = afc<<4 | w.cc[pid]
	w.cc[pid] = (w.cc[pid] + 1) & 0x0f
	copy(p[off:], payload)
	for i := off + len(payload); i < 188; i++ {
		p[i] = 0xff
	}
	return p
}

func pat() []byte {
	// pointer, table 0, len 13, tsid 1, ver, sec 0/0, prog 1 → PMT 0x1000, crc
	return []byte{0, 0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0}
}

func pmt() []byte {
	// table 2, PCR PID 256, H.264 on 256, AAC on 257
	return []byte{0, 0x02, 0xb0, 23, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00,
		0x1b, 0xe1, 0x00, 0xf0, 0x00,
		0x0f, 0xe1, 0x01, 0xf0, 0x00,
		0, 0, 0, 0}
}

// stream generates n video frames at fps with PCR on each, plus psi.
func stream(w *tsw, frames, fps int, pcrStart int64) []byte {
	var b bytes.Buffer
	b.Write(w.pkt(0, true, pat(), -1))
	b.Write(w.pkt(0x1000, true, pmt(), -1))
	step := int64(27_000_000 / fps)
	for i := 0; i < frames; i++ {
		b.Write(w.pkt(256, true, []byte{0, 0, 1, 0xe0}, pcrStart+int64(i)*step))
		b.Write(w.pkt(256, false, []byte{1, 2, 3}, -1))
		if i%2 == 0 {
			b.Write(w.pkt(257, true, []byte{0, 0, 1, 0xc0}, -1))
		}
	}
	return b.Bytes()
}

func TestAnalyzeReaderCountsFramesAndRates(t *testing.T) {
	data := stream(newTSW(), 250, 25, 1000)
	s, err := AnalyzeReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if s.VideoCodec != "h264" || s.AudioCodec != "aac" || s.VideoPID != 256 || s.AudioPID != 257 {
		t.Fatalf("psi: %+v", s)
	}
	if s.VideoFrames != 250 || s.AudioFrames != 125 {
		t.Fatalf("frames v=%d a=%d", s.VideoFrames, s.AudioFrames)
	}
	if s.FPS < 25 || s.FPS > 25.2 || s.StreamSeconds < 9.9 || s.StreamSeconds > 10 {
		t.Fatalf("fps %.2f over %.2fs", s.FPS, s.StreamSeconds)
	}
	if s.CCErrors != 0 || s.SyncErrors != 0 {
		t.Fatalf("errors: %+v", s)
	}
}

func TestAnalyzerDetectsCCErrorsAndPCRJumps(t *testing.T) {
	w := newTSW()
	a := NewAnalyzer()
	a.Feed(stream(w, 10, 25, 0))
	w.cc[256] = (w.cc[256] + 5) & 0x0f       // lose 5 packets
	a.Feed(stream(w, 10, 25, 27_000_000*60)) // PCR jumps 60 s → discontinuity
	s := a.Stats()
	if s.CCErrors < 1 {
		t.Fatal("CC gap not detected")
	}
	if s.PCRResets != 1 {
		t.Fatalf("PCR discontinuities = %d", s.PCRResets)
	}
}

func TestAnalyzerSyncErrorsAndUnalignedStart(t *testing.T) {
	data := append([]byte{1, 2, 3}, stream(newTSW(), 5, 25, 0)...)
	s, _ := AnalyzeReader(bytes.NewReader(data))
	if s.VideoFrames != 5 {
		t.Fatalf("resync failed: %+v", s)
	}
	a := NewAnalyzer()
	a.Feed(bytes.Repeat([]byte{0}, 188))
	if a.Stats().SyncErrors != 1 {
		t.Fatal("sync error not counted")
	}
}

func TestPCRDriftAgainstWallClock(t *testing.T) {
	a := NewAnalyzer()
	now := time.Unix(1000, 0)
	a.now = func() time.Time { return now }
	w := newTSW()
	a.Feed(w.pkt(0, true, pat(), -1))
	a.Feed(w.pkt(0x1000, true, pmt(), -1))
	// stream clock runs 1% fast: 10.1 s of PCR in 10 s of wall time
	for i := 0; i <= 100; i++ {
		now = time.Unix(1000, 0).Add(time.Duration(i) * 100 * time.Millisecond)
		a.Feed(w.pkt(256, true, []byte{0, 0, 1, 0xe0}, int64(i)*2_727_000))
	}
	if d := a.Stats().PCRDriftMs; d < 95 || d > 105 {
		t.Fatalf("drift = %.1f ms, want ≈ +100", d)
	}
}

func TestBusFansOutAndSurvivesDeadSink(t *testing.T) {
	bus, err := Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	port := bus.Port()
	recv := func() (*net.UDPConn, int) {
		c, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
		if err != nil {
			t.Fatal(err)
		}
		return c, c.LocalAddr().(*net.UDPAddr).Port
	}
	r1, p1 := recv()
	defer r1.Close()
	r2, p2 := recv()
	bus.AddSink("a", p1)
	bus.AddSink("b", p2)
	r2.Close() // dead output: must not affect "a"
	src, _ := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
	defer src.Close()
	data := stream(newTSW(), 30, 25, 0)
	sent := 0
	for i := 0; i+1316 <= len(data); i += 1316 {
		_, _ = src.Write(data[i : i+1316])
		sent++
	}
	got := 0
	buf := make([]byte, 2000)
	_ = r1.SetReadDeadline(time.Now().Add(2 * time.Second))
	for got < sent {
		n, err := r1.Read(buf)
		if err != nil {
			break
		}
		if n == 1316 {
			got++
		}
	}
	if got != sent {
		t.Fatalf("sink a got %d/%d datagrams", got, sent)
	}
	time.Sleep(50 * time.Millisecond)
	if st := bus.Stats(); st.VideoFrames == 0 || st.Packets == 0 {
		t.Fatalf("bus analysis empty: %+v", st)
	}
	bus.RemoveSink("a")
	if _, ok := bus.SinkStats()["a"]; ok {
		t.Fatal("sink not removed")
	}
}
