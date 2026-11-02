package channel

import (
	"errors"
	"sync/atomic"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/scte35"
)

// applySCTE35 installs/removes/updates the bus SCTE-35 injector live.
func (m *Manager) applySCTE35(rt *chanRT, ch config.Channel) {
	s := ch.SCTE35
	cur := rt.bus.Injector()
	if s == nil || !s.Enabled {
		if cur != nil {
			rt.bus.SetInjector(nil)
		}
		return
	}
	if cur != nil && int(cur.PID()) == s.PID {
		cur.SetHeartbeat(time.Duration(s.HeartbeatSec) * time.Second)
		return
	}
	inj := scte35.NewInjector(uint16(s.PID))
	inj.SetHeartbeat(time.Duration(s.HeartbeatSec) * time.Second)
	rt.bus.SetInjector(inj)
}

// restartMonitor (re)starts the confidence monitor of a channel.
func (m *Manager) restartMonitor(rt *chanRT, ch config.Channel) {
	rt.mu.Lock()
	old := rt.mon
	rt.mon = nil
	rt.mu.Unlock()
	if old != nil {
		old.Close()
	}
	ach := ch.Audio.Channels
	if ch.Audio.Disabled {
		ach = 0
	}
	mon, err := StartMonitor(rt.thumbPort, rt.pcmPort, ach)
	if err != nil {
		m.d.Log.Warn("monitor start", "channel", ch.ID, "err", err)
		return
	}
	rt.mu.Lock()
	rt.mon = mon
	rt.mu.Unlock()
}

func (m *Manager) runtime(id string) *chanRT {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.chans[id]
}

var cueSeq atomic.Uint32

// ErrNotRunning is returned for operations that need a running channel.
var ErrNotRunning = errors.New("channel is not running")

// InsertSCTE35 queues a cue on a running channel with SCTE-35 enabled.
// EventID 0 gets an automatic, increasing id.
func (m *Manager) InsertSCTE35(id string, c scte35.Cue) (uint64, scte35.Cue, error) {
	rt := m.runtime(id)
	if rt == nil {
		return 0, c, ErrNotRunning
	}
	inj := rt.bus.Injector()
	if inj == nil {
		return 0, c, errors.New("SCTE-35 is not enabled on this channel (set scte35.enabled)")
	}
	if c.EventID == 0 {
		c.EventID = uint32(time.Now().Unix()&0xffff)<<16 | cueSeq.Add(1)&0xffff
	}
	pts, err := inj.Insert(c)
	return pts, c, err
}

// SCTE35Stats returns the injector stats of a running channel.
func (m *Manager) SCTE35Stats(id string) (scte35.Stats, bool) {
	rt := m.runtime(id)
	if rt == nil || rt.bus.Injector() == nil {
		return scte35.Stats{}, false
	}
	return rt.bus.Injector().Stats(), true
}

// Thumbnail returns the last confidence JPEG of a running channel.
func (m *Manager) Thumbnail(id string) ([]byte, time.Time, bool) {
	rt := m.runtime(id)
	if rt == nil {
		return nil, time.Time{}, false
	}
	rt.mu.Lock()
	mon := rt.mon
	rt.mu.Unlock()
	if mon == nil {
		return nil, time.Time{}, false
	}
	b, at := mon.JPEG()
	return b, at, len(b) > 0
}

// ResetLoudness restarts the integrated loudness of a running channel.
func (m *Manager) ResetLoudness(id string) bool {
	rt := m.runtime(id)
	if rt == nil {
		return false
	}
	rt.mu.Lock()
	mon := rt.mon
	rt.mu.Unlock()
	if mon == nil {
		return false
	}
	mon.ResetLoudness()
	return true
}
