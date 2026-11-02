package channel

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"net"
	"sync"
	"testing"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/notify"
)

func TestAlarmBookHoldRaiseClear(t *testing.T) {
	var mu sync.Mutex
	var evs []notify.Event
	b := newAlarmBook(func(e notify.Event) { mu.Lock(); evs = append(evs, e); mu.Unlock() }, "enc-1")
	t0 := time.Unix(1000, 0)
	for s := 0; s < 5; s++ { // 4 s of condition, hold 5 s → nothing yet
		b.observe(t0.Add(time.Duration(s)*time.Second), "ch1", "black", "", true, 5*time.Second, "black", 3)
	}
	if a, _ := b.list(); len(a) != 0 {
		t.Fatal("raised before hold")
	}
	b.observe(t0.Add(5*time.Second), "ch1", "black", "", true, 5*time.Second, "black", 3)
	a, _ := b.list()
	if len(a) != 1 || a[0].Severity != "major" || a[0].Channel != "ch1" {
		t.Fatalf("not raised: %+v", a)
	}
	if !b.ack(a[0].ID, "op") {
		t.Fatal("ack")
	}
	b.observe(t0.Add(6*time.Second), "ch1", "black", "", true, 5*time.Second, "black", 3) // still active: no duplicate
	b.observe(t0.Add(7*time.Second), "ch1", "black", "", false, 5*time.Second, "", 0)
	if a, h := b.list(); len(a) != 0 || len(h) != 2 || h[0].ClearedAt == nil {
		t.Fatalf("clear: active=%v history=%v", a, h)
	}
	// a flapping condition shorter than the hold never raises
	b.observe(t0.Add(8*time.Second), "ch1", "black", "", true, 5*time.Second, "", 0)
	b.observe(t0.Add(10*time.Second), "ch1", "black", "", false, 5*time.Second, "", 0)
	b.observe(t0.Add(11*time.Second), "ch1", "black", "", true, 5*time.Second, "", 0)
	if a, _ := b.list(); len(a) != 0 {
		t.Fatal("hold not reset by a clear")
	}
	mu.Lock()
	ok := len(evs) == 2 && evs[0].Active && !evs[1].Active && evs[0].Device == "enc-1" && evs[0].Type == "black"
	mu.Unlock()
	if !ok {
		t.Fatalf("events: %+v", evs)
	}
	// clearChannel clears everything of the channel
	b.observe(t0, "ch2", "silence", "", true, 0, "", 0)
	b.observe(t0, "ch2", "output_down", "o1", true, 0, "", 0)
	b.clearChannel(t0.Add(time.Second), "ch2")
	if a, _ := b.list(); len(a) != 0 {
		t.Fatalf("clearChannel left %v", a)
	}
}

func TestMonitorThumbnailsLumaMotion(t *testing.T) {
	tp := freePort(t)
	m, err := StartMonitor(tp, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	send := func(v uint8) {
		img := image.NewGray(image.Rect(0, 0, 320, 180))
		for i := range img.Pix {
			img.Pix[i] = v
		}
		img.Set(int(v)%320, 10, color.Gray{255 - v})
		var buf bytes.Buffer
		_ = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 70})
		c, _ := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: tp})
		_, _ = c.Write(buf.Bytes())
		c.Close()
		time.Sleep(50 * time.Millisecond)
	}
	send(16)
	send(16)
	s := m.Snapshot()
	if !s.VideoLive || s.Luma > 20 || s.Motion < 0 || s.Motion > 0.25 || s.Thumbs != 2 {
		t.Fatalf("black+frozen expected: %+v", s)
	}
	send(200)
	if s = m.Snapshot(); s.Luma < 150 || s.Motion < 50 {
		t.Fatalf("bright change expected: %+v", s)
	}
	if b, _ := m.JPEG(); len(b) == 0 {
		t.Fatal("no jpeg kept")
	}
}

func TestMonitorPCMLoudness(t *testing.T) {
	pp := freePort(t)
	m, err := StartMonitor(0, pp, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	c, _ := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: pp})
	defer c.Close()
	frame := make([]byte, 960*4) // 20 ms stereo silence
	for i := 0; i < 50; i++ {
		_, _ = c.Write(frame)
	}
	time.Sleep(100 * time.Millisecond)
	s := m.Snapshot()
	if !s.AudioLive || s.Loudness == nil || s.Loudness.MomentaryLUFS > -69 {
		t.Fatalf("silence expected: %+v", s.Loudness)
	}
}

func freePort(t *testing.T) int {
	c, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	p := c.LocalAddr().(*net.UDPAddr).Port
	c.Close()
	return p
}
