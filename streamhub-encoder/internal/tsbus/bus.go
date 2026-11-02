package tsbus

import (
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/scte35"
)

// Bus receives the engine's TS on 127.0.0.1:Port and fans it out.
type Bus struct {
	conn *net.UDPConn
	out  *net.UDPConn // unconnected sender socket
	port int

	mu    sync.RWMutex
	sinks map[string]*sink

	an     atomic.Pointer[Analyzer]
	inj    atomic.Pointer[scte35.Injector]
	closed atomic.Bool
	done   chan struct{}
}

type sink struct {
	addr    *net.UDPAddr
	sent    atomic.Int64
	dropped atomic.Int64
}

// SinkStats per output.
type SinkStats struct {
	Addr    string `json:"addr"`
	Sent    int64  `json:"sent"`
	Dropped int64  `json:"dropped"`
}

// Listen opens the bus on 127.0.0.1:port.
func Listen(port int) (*Bus, error) {
	c, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
	if err != nil {
		return nil, err
	}
	_ = c.SetReadBuffer(8 << 20)
	o, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		c.Close()
		return nil, err
	}
	_ = o.SetWriteBuffer(8 << 20)
	b := &Bus{conn: c, out: o, port: c.LocalAddr().(*net.UDPAddr).Port, sinks: map[string]*sink{}, done: make(chan struct{})}
	b.an.Store(NewAnalyzer())
	go b.loop()
	return b, nil
}

// Port is the listening port (engine target).
func (b *Bus) Port() int { return b.port }

// AddSink forwards every datagram to 127.0.0.1:port under id (replacing any).
func (b *Bus) AddSink(id string, port int) {
	b.mu.Lock()
	b.sinks[id] = &sink{addr: &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port}}
	b.mu.Unlock()
}

// RemoveSink stops forwarding to id.
func (b *Bus) RemoveSink(id string) {
	b.mu.Lock()
	delete(b.sinks, id)
	b.mu.Unlock()
}

// SinkStats returns per-sink counters.
func (b *Bus) SinkStats() map[string]SinkStats {
	b.mu.RLock()
	defer b.mu.RUnlock()
	m := make(map[string]SinkStats, len(b.sinks))
	for id, s := range b.sinks {
		m[id] = SinkStats{Addr: s.addr.String(), Sent: s.sent.Load(), Dropped: s.dropped.Load()}
	}
	return m
}

// SetInjector installs (or with nil removes) a SCTE-35 injector that
// rewrites the PMT and splices cues into the stream before the fan-out.
func (b *Bus) SetInjector(i *scte35.Injector) { b.inj.Store(i) }

// Injector returns the installed SCTE-35 injector (nil if none).
func (b *Bus) Injector() *scte35.Injector { return b.inj.Load() }

// Stats returns the stream analysis.
func (b *Bus) Stats() Stats { return b.an.Load().Stats() }

// ResetStats starts a fresh analysis (after an engine restart the PCR base,
// CC counters and PIDs change).
func (b *Bus) ResetStats() { b.an.Store(NewAnalyzer()) }

// Idle reports how long since the last datagram (since open if none).
func (b *Bus) Idle(openedAt time.Time) time.Duration {
	s := b.an.Load().Stats()
	if s.LastPacketAt.IsZero() {
		return time.Since(openedAt)
	}
	return time.Since(s.LastPacketAt)
}

// Close stops the bus.
func (b *Bus) Close() error {
	if b.closed.Swap(true) {
		return nil
	}
	err := b.conn.Close()
	<-b.done
	b.out.Close()
	return err
}

func (b *Bus) loop() {
	defer close(b.done)
	buf := make([]byte, 65536)
	for {
		n, _, err := b.conn.ReadFromUDP(buf)
		if err != nil {
			if b.closed.Load() || errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		dgrams := [][]byte{buf[:n]}
		if inj := b.inj.Load(); inj != nil {
			dgrams = inj.Process(buf[:n])
		}
		for _, pkt := range dgrams {
			b.mu.RLock()
			for _, s := range b.sinks {
				// Loopback UDP never blocks for long; a full receiver buffer
				// (dead/slow output) shows up as an error → counted, skipped.
				if _, err := b.out.WriteToUDP(pkt, s.addr); err != nil {
					s.dropped.Add(1)
				} else {
					s.sent.Add(1)
				}
			}
			b.mu.RUnlock()
			b.an.Load().Feed(pkt)
		}
	}
}
