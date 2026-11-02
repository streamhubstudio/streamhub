package channel

import (
	"bytes"
	"errors"
	"image"
	"image/jpeg"
	"math"
	"net"
	"sync"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/loudness"
)

// Monitor consumes the engine's confidence taps: 2 fps JPEG thumbnails
// (kept for the UI, analysed for black/freeze) and the main audio track as
// S16LE PCM (EBU R128 loudness, peak/RMS meters, silence).
type Monitor struct {
	thumb, pcm *net.UDPConn
	channels   int

	mu       sync.Mutex
	jpeg     []byte
	jpegAt   time.Time
	luma     float64 // mean Y (0..255)
	motion   float64 // mean |ΔY| vs previous thumbnail (-1 = unknown)
	prev     []uint8
	meter    *loudness.Meter
	pcmAt    time.Time
	thumbs   int64
	pcmBytes int64

	wg sync.WaitGroup
}

// MonitorSnapshot is the monitoring view of a channel.
type MonitorSnapshot struct {
	ThumbAt   time.Time          `json:"thumbAt,omitempty"`
	Thumbs    int64              `json:"thumbs"`
	Luma      float64            `json:"luma"`
	Motion    float64            `json:"motion"`
	AudioAt   time.Time          `json:"audioAt,omitempty"`
	Loudness  *loudness.Snapshot `json:"loudness,omitempty"`
	VideoLive bool               `json:"videoLive"`
	AudioLive bool               `json:"audioLive"`
}

func listenLoop(port int) (*net.UDPConn, error) {
	c, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
	if err != nil {
		return nil, err
	}
	_ = c.SetReadBuffer(4 << 20)
	return c, nil
}

// StartMonitor listens on the tap ports (0 = tap disabled).
func StartMonitor(thumbPort, pcmPort, audioChannels int) (*Monitor, error) {
	m := &Monitor{channels: audioChannels, motion: -1}
	if thumbPort > 0 {
		c, err := listenLoop(thumbPort)
		if err != nil {
			return nil, err
		}
		m.thumb = c
		m.wg.Add(1)
		go m.thumbLoop()
	}
	if pcmPort > 0 && audioChannels >= 1 && audioChannels <= loudness.MaxChannels {
		c, err := listenLoop(pcmPort)
		if err != nil {
			m.Close()
			return nil, err
		}
		m.pcm = c
		m.meter = loudness.NewMeter(48000, audioChannels)
		m.wg.Add(1)
		go m.pcmLoop()
	}
	return m, nil
}

// Close stops the monitor.
func (m *Monitor) Close() {
	if m.thumb != nil {
		m.thumb.Close()
	}
	if m.pcm != nil {
		m.pcm.Close()
	}
	m.wg.Wait()
}

func (m *Monitor) thumbLoop() {
	defer m.wg.Done()
	buf := make([]byte, 65536)
	for {
		n, _, err := m.thumb.ReadFromUDP(buf)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		data := append([]byte(nil), buf[:n]...)
		img, err := jpeg.Decode(bytes.NewReader(data))
		if err != nil {
			continue
		}
		luma, sample := lumaSample(img)
		m.mu.Lock()
		m.jpeg, m.jpegAt, m.luma = data, time.Now(), luma
		m.thumbs++
		if len(m.prev) == len(sample) && len(sample) > 0 {
			var d float64
			for i := range sample {
				d += math.Abs(float64(sample[i]) - float64(m.prev[i]))
			}
			m.motion = d / float64(len(sample))
		}
		m.prev = sample
		m.mu.Unlock()
	}
}

// lumaSample returns the mean luma and a 4-px-step luma sample of a JPEG frame.
func lumaSample(img image.Image) (float64, []uint8) {
	var out []uint8
	var sum float64
	switch y := img.(type) {
	case *image.YCbCr:
		r := y.Rect
		for yy := r.Min.Y; yy < r.Max.Y; yy += 4 {
			for xx := r.Min.X; xx < r.Max.X; xx += 4 {
				v := y.Y[y.YOffset(xx, yy)]
				out = append(out, v)
				sum += float64(v)
			}
		}
	case *image.Gray:
		r := y.Rect
		for yy := r.Min.Y; yy < r.Max.Y; yy += 4 {
			for xx := r.Min.X; xx < r.Max.X; xx += 4 {
				v := y.GrayAt(xx, yy).Y
				out = append(out, v)
				sum += float64(v)
			}
		}
	}
	if len(out) == 0 {
		return 0, nil
	}
	return sum / float64(len(out)), out
}

func (m *Monitor) pcmLoop() {
	defer m.wg.Done()
	buf := make([]byte, 65536)
	for {
		n, _, err := m.pcm.ReadFromUDP(buf)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		m.meter.WriteS16LE(buf[:n])
		m.mu.Lock()
		m.pcmAt = time.Now()
		m.pcmBytes += int64(n)
		m.mu.Unlock()
	}
}

// Snapshot returns the current monitoring values.
func (m *Monitor) Snapshot() MonitorSnapshot {
	m.mu.Lock()
	s := MonitorSnapshot{ThumbAt: m.jpegAt, Thumbs: m.thumbs, Luma: round2(m.luma), Motion: round2(m.motion), AudioAt: m.pcmAt}
	s.VideoLive = !m.jpegAt.IsZero() && time.Since(m.jpegAt) < 3*time.Second
	s.AudioLive = !m.pcmAt.IsZero() && time.Since(m.pcmAt) < 3*time.Second
	m.mu.Unlock()
	if m.meter != nil {
		l := m.meter.Snapshot()
		s.Loudness = &l
	}
	return s
}

// JPEG returns the last thumbnail.
func (m *Monitor) JPEG() ([]byte, time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.jpeg, m.jpegAt
}

// ResetLoudness restarts the integrated loudness measurement.
func (m *Monitor) ResetLoudness() {
	if m.meter != nil {
		m.meter.Reset()
	}
}

func round2(f float64) float64 { return math.Round(f*100) / 100 }
