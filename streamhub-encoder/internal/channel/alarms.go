package channel

import (
	"fmt"
	"sort"
	"sync"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/notify"
)

// Alarm is an active or past alarm.
type Alarm struct {
	ID        string     `json:"id"`
	Type      string     `json:"type"`
	Severity  string     `json:"severity"`
	Channel   string     `json:"channel"`
	Output    string     `json:"output,omitempty"`
	Message   string     `json:"message"`
	Value     float64    `json:"value,omitempty"`
	RaisedAt  time.Time  `json:"raisedAt"`
	ClearedAt *time.Time `json:"clearedAt,omitempty"`
	Acked     bool       `json:"acked"`
	AckedBy   string     `json:"ackedBy,omitempty"`
}

var severities = map[string]string{
	config.AlarmEngineDown: "critical", config.AlarmInputLoss: "critical",
	config.AlarmBlack: "major", config.AlarmFreeze: "major", config.AlarmSilence: "major", config.AlarmOutputDown: "major",
	config.AlarmBitrateDrop: "minor", config.AlarmLoudness: "warning",
}

// alarmBook tracks conditions, raises after their hold time, clears when they
// go away, and forwards both edges to the notifier.
type alarmBook struct {
	mu      sync.Mutex
	since   map[string]time.Time // condition key → first seen (pending)
	active  map[string]*Alarm
	history []Alarm
	seq     int64
	send    func(notify.Event)
	device  string
}

func newAlarmBook(send func(notify.Event), device string) *alarmBook {
	return &alarmBook{since: map[string]time.Time{}, active: map[string]*Alarm{}, send: send, device: device}
}

func akey(ch, typ, out string) string { return ch + "|" + typ + "|" + out }

// observe feeds one condition sample: cond true for at least hold → raise.
func (b *alarmBook) observe(now time.Time, ch, typ, out string, cond bool, hold time.Duration, msg string, value float64) {
	k := akey(ch, typ, out)
	b.mu.Lock()
	defer b.mu.Unlock()
	if !cond {
		delete(b.since, k)
		if a := b.active[k]; a != nil {
			t := now
			a.ClearedAt = &t
			b.push(*a)
			delete(b.active, k)
			b.emit(*a, false)
		}
		return
	}
	if b.active[k] != nil {
		return
	}
	first, ok := b.since[k]
	if !ok {
		b.since[k] = now
		first = now
	}
	if now.Sub(first) < hold {
		return
	}
	b.seq++
	a := &Alarm{ID: fmt.Sprintf("al-%d-%d", now.Unix(), b.seq), Type: typ, Severity: severities[typ], Channel: ch, Output: out,
		Message: msg, Value: value, RaisedAt: now}
	b.active[k] = a
	b.push(*a)
	b.emit(*a, true)
}

// clearChannel clears every alarm of a channel (stopped/removed).
func (b *alarmBook) clearChannel(now time.Time, ch string) {
	b.mu.Lock()
	var keys []string
	for k, a := range b.active {
		if a.Channel == ch {
			keys = append(keys, k)
		}
	}
	for k := range b.since {
		if len(k) > len(ch) && k[:len(ch)+1] == ch+"|" {
			delete(b.since, k)
		}
	}
	b.mu.Unlock()
	for _, k := range keys {
		b.mu.Lock()
		a := b.active[k]
		b.mu.Unlock()
		if a != nil {
			b.observe(now, a.Channel, a.Type, a.Output, false, 0, "", 0)
		}
	}
}

func (b *alarmBook) push(a Alarm) {
	b.history = append(b.history, a)
	if len(b.history) > 500 {
		b.history = b.history[len(b.history)-500:]
	}
}

func (b *alarmBook) emit(a Alarm, active bool) {
	if b.send == nil {
		return
	}
	b.send(notify.Event{ID: a.ID, Type: a.Type, Severity: a.Severity, Active: active, Channel: a.Channel, Output: a.Output,
		Message: a.Message, Value: a.Value, At: time.Now().UTC(), Device: b.device})
}

// list returns active alarms (sorted by time) and the recent history.
func (b *alarmBook) list() (active []Alarm, history []Alarm) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, a := range b.active {
		active = append(active, *a)
	}
	sort.Slice(active, func(i, j int) bool { return active[i].RaisedAt.Before(active[j].RaisedAt) })
	history = make([]Alarm, len(b.history))
	for i := range b.history {
		history[len(b.history)-1-i] = b.history[i] // newest first
	}
	if active == nil {
		active = []Alarm{}
	}
	return active, history
}

func (b *alarmBook) ack(id, by string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, a := range b.active {
		if a.ID == id {
			a.Acked, a.AckedBy = true, by
			return true
		}
	}
	return false
}

// activeTypes returns "type[/output]" of the active alarms of a channel.
func (b *alarmBook) activeFor(ch string) []Alarm {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []Alarm
	for _, a := range b.active {
		if a.Channel == ch {
			out = append(out, *a)
		}
	}
	return out
}

// evaluateAlarms runs once per second per running channel.
func (m *Manager) evaluateAlarms(rt *chanRT, now time.Time) {
	rt.mu.Lock()
	ch := rt.cfg
	mon := rt.mon
	outs := make(map[string]*outRT, len(rt.outs))
	for k, v := range rt.outs {
		outs[k] = v
	}
	started := rt.startedAt
	rt.mu.Unlock()
	opt := ch.AlarmDefaults()
	en := opt.AlarmEnabled
	sec := func(s int) time.Duration { return time.Duration(s) * time.Second }
	cs := m.channelStatus(ch)
	warm := now.Sub(started) > m.d.StartGrace/2

	m.alarms.observe(now, ch.ID, config.AlarmEngineDown, "", en(config.AlarmEngineDown) && (cs.State == StateReconnecting || cs.State == StateError),
		5*time.Second, "engine not producing: "+cs.Error, 0)

	if cs.Stats != nil && warm {
		target := float64(ch.Video.BitrateKbps)
		low := cs.Stats.BitrateKbps < target*float64(opt.BitrateDropPct)/100
		m.alarms.observe(now, ch.ID, config.AlarmBitrateDrop, "", en(config.AlarmBitrateDrop) && cs.State != StateStopped && low,
			10*time.Second, fmt.Sprintf("TS bitrate %.0f kbps < %d%% of the %d kbps target", cs.Stats.BitrateKbps, opt.BitrateDropPct, ch.Video.BitrateKbps), cs.Stats.BitrateKbps)
	}
	for _, o := range ch.Outputs {
		if !o.Enabled {
			continue
		}
		var st OutputStatus
		for _, x := range cs.Outputs {
			if x.ID == o.ID {
				st = x
			}
		}
		m.alarms.observe(now, ch.ID, config.AlarmOutputDown, o.ID, en(config.AlarmOutputDown) && warm && st.State != "running",
			10*time.Second, fmt.Sprintf("output %s %s: %s", o.ID, st.State, st.Error), 0)
	}
	if mon == nil {
		return
	}
	ms := mon.Snapshot()
	black := ms.VideoLive && ms.Luma < 20
	frozen := ms.VideoLive && ms.Motion >= 0 && ms.Motion < 0.25
	silent := false
	if !ch.Audio.Disabled && ms.Loudness != nil && ms.AudioLive {
		silent = true
		for _, r := range ms.Loudness.RMSDBFS {
			if r > opt.SilenceDBFS {
				silent = false
			}
		}
	}
	m.alarms.observe(now, ch.ID, config.AlarmBlack, "", en(config.AlarmBlack) && black, sec(opt.BlackSec), fmt.Sprintf("black picture (luma %.1f)", ms.Luma), ms.Luma)
	m.alarms.observe(now, ch.ID, config.AlarmFreeze, "", en(config.AlarmFreeze) && frozen, sec(opt.FreezeSec), fmt.Sprintf("frozen picture (motion %.2f)", ms.Motion), ms.Motion)
	m.alarms.observe(now, ch.ID, config.AlarmSilence, "", en(config.AlarmSilence) && silent, sec(opt.SilenceSec), fmt.Sprintf("audio below %.0f dBFS", opt.SilenceDBFS), 0)
	m.alarms.observe(now, ch.ID, config.AlarmInputLoss, "", en(config.AlarmInputLoss) && black && (silent || ch.Audio.Disabled), 3*time.Second,
		"input lost (black + silence: fallback/slate on air)", 0)
	if opt.LoudnessTarget != 0 && ms.Loudness != nil && ms.AudioLive && !silent && ms.Loudness.Seconds > 10 {
		d := ms.Loudness.ShortTermLUFS - opt.LoudnessTarget
		m.alarms.observe(now, ch.ID, config.AlarmLoudness, "", en(config.AlarmLoudness) && (d > opt.LoudnessTolLU || d < -opt.LoudnessTolLU), 30*time.Second,
			fmt.Sprintf("short-term loudness %.1f LUFS vs target %.1f", ms.Loudness.ShortTermLUFS, opt.LoudnessTarget), ms.Loudness.ShortTermLUFS)
	}
}

// Alarms returns active alarms and history (newest first).
func (m *Manager) Alarms() (active, history []Alarm) { return m.alarms.list() }

// AckAlarm acknowledges an active alarm.
func (m *Manager) AckAlarm(id, by string) bool { return m.alarms.ack(id, by) }
