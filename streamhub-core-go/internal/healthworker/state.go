package healthworker

import (
	"math"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/streamhealth"
)

// Port of state.js: the per-room threshold state machine (time is an
// explicit parameter). Detectors: stalled (level, critical), audio (level:
// missing track, or ≤ silence_db for ≥ silence_duration_sec), av_desync
// (level), bitrate_low (level vs a healthy EMA baseline, rollup only) and
// discontinuity (pulse, ≤ 1 event per DiscontinuityCooldownSec). Rollup:
// critical when stalled or ≥ 2 issues, degraded for 1, healthy after
// recover_samples clean samples; health.degraded fires on every worsening.

// DiscontinuityCooldownSec rate-limits health.discontinuity.
const DiscontinuityCooldownSec = 60

// RoomState is one room's detector state.
type RoomState struct {
	Status                  string
	LastReasons             []string
	CleanStreak             float64
	AudioLost               bool
	AudioCleanStreak        float64
	SilentSinceMs           *float64
	DesyncActive            bool
	DesyncCleanStreak       float64
	StallActive             bool
	LastDiscontinuityEmitMs *float64
	BaselineKbps            *float64
}

// NewRoomState is createRoomState.
func NewRoomState() *RoomState { return &RoomState{Status: "healthy", LastReasons: []string{}} }

// Sample is one sampling cycle's observations; nil = not observed.
type Sample struct {
	SecondsSinceAdvance  float64
	DroppedSegments      float64
	CCErrors             float64
	NewDiscontinuityTags float64
	HasAudioTrack        *bool
	MeanDb               *float64
	DesyncMs             *float64
	MeasuredKbps         *float64
}

// Event is one emitted domain event (data keeps the Node key order).
type Event struct {
	Event string
	Data  *y.Map
}

// Result is evaluate()'s return.
type Result struct {
	Events  []Event
	Status  string
	Reasons []string
}

func obj(kv ...any) *y.Map {
	m := y.NewMap()
	for i := 0; i+1 < len(kv); i += 2 {
		m.Set(kv[i].(string), kv[i+1])
	}
	return m
}

func strList(l []string) []any {
	out := make([]any, len(l))
	for i, s := range l {
		out[i] = s
	}
	return out
}

var rank = map[string]int{"healthy": 0, "degraded": 1, "critical": 2}

// Evaluate runs one sampling cycle for one room (state is mutated).
func Evaluate(st *RoomState, s Sample, t streamhealth.HealthThresholds, nowMs float64) Result {
	events := []Event{}
	var reasons []string
	emit := func(name string, data *y.Map) { events = append(events, Event{name, data}) }

	// stall (level, critical)
	stalled := s.SecondsSinceAdvance >= t.StallSec
	if stalled {
		reasons = append(reasons, "stalled")
		if !st.StallActive {
			emit("health.stalled", obj("stalledForSec", jsRound(s.SecondsSinceAdvance)))
		}
	}
	st.StallActive = stalled

	// audio (level)
	audioIssue := ""
	if s.HasAudioTrack != nil && !*s.HasAudioTrack {
		audioIssue = "audio_missing"
		st.SilentSinceMs = nil
	} else if s.MeanDb != nil {
		if *s.MeanDb <= t.SilenceDB {
			if st.SilentSinceMs == nil {
				v := nowMs
				st.SilentSinceMs = &v
			}
			if (nowMs-*st.SilentSinceMs)/1000 >= t.SilenceDurationSec {
				audioIssue = "audio_silent"
			}
		} else {
			st.SilentSinceMs = nil
		}
	}
	audioObserved := (s.HasAudioTrack != nil && !*s.HasAudioTrack) || s.MeanDb != nil
	switch {
	case audioIssue != "":
		reasons = append(reasons, audioIssue)
		st.AudioCleanStreak = 0
		if !st.AudioLost {
			st.AudioLost = true
			if audioIssue == "audio_missing" {
				emit("health.audio_lost", obj("reason", "no_audio_track"))
			} else {
				since := nowMs
				if st.SilentSinceMs != nil {
					since = *st.SilentSinceMs
				}
				emit("health.audio_lost", obj("reason", "silence", "silenceDb", *s.MeanDb, "silentForSec", jsRound((nowMs-since)/1000)))
			}
		}
	case audioObserved:
		if st.AudioLost {
			st.AudioCleanStreak++
			if st.AudioCleanStreak >= t.RecoverSamples {
				st.AudioLost = false
				st.AudioCleanStreak = 0
				emit("health.audio_recovered", y.NewMap())
			}
		}
	case st.AudioLost:
		reasons = append(reasons, "audio_silent") // no observation: coast
	}

	// A/V desync (level)
	if s.DesyncMs != nil {
		if math.Abs(*s.DesyncMs) >= t.DesyncMs {
			reasons = append(reasons, "av_desync")
			st.DesyncCleanStreak = 0
			if !st.DesyncActive {
				st.DesyncActive = true
				emit("health.av_desync", obj("desyncMs", jsRound(*s.DesyncMs)))
			}
		} else if st.DesyncActive {
			st.DesyncCleanStreak++
			if st.DesyncCleanStreak >= t.RecoverSamples {
				st.DesyncActive = false
				st.DesyncCleanStreak = 0
			}
		}
	} else if st.DesyncActive {
		reasons = append(reasons, "av_desync")
	}

	// discontinuities (pulse)
	if s.DroppedSegments > 0 || s.CCErrors > 0 || s.NewDiscontinuityTags > 0 {
		reasons = append(reasons, "discontinuity")
		if last := st.LastDiscontinuityEmitMs; last == nil || nowMs-*last >= DiscontinuityCooldownSec*1000 {
			v := nowMs
			st.LastDiscontinuityEmitMs = &v
			emit("health.discontinuity", obj("droppedSegments", s.DroppedSegments, "ccErrors", s.CCErrors, "discontinuityTags", s.NewDiscontinuityTags))
		}
	}

	// bitrate drop vs the rolling healthy baseline (rollup only)
	if k := s.MeasuredKbps; k != nil && *k > 0 {
		if t.BitrateDropPct > 0 && st.BaselineKbps != nil && *k < *st.BaselineKbps*t.BitrateDropPct/100 {
			reasons = append(reasons, "bitrate_low")
		} else {
			// only healthy readings feed the baseline (no self-drag)
			b := *k
			if st.BaselineKbps != nil {
				b = jsRound(*st.BaselineKbps*0.8 + *k*0.2)
			}
			st.BaselineKbps = &b
		}
	}

	// rollup
	distinct := []string{}
	seen := map[string]bool{}
	for _, r := range reasons {
		if !seen[r] {
			seen[r] = true
			distinct = append(distinct, r)
		}
	}
	target := "healthy"
	switch {
	case stalled || len(distinct) >= 2:
		target = "critical"
	case len(distinct) == 1:
		target = "degraded"
	}
	if target == "healthy" {
		if st.Status != "healthy" {
			st.CleanStreak++
			if st.CleanStreak >= t.RecoverSamples {
				cleared := st.LastReasons
				st.Status, st.CleanStreak, st.LastReasons = "healthy", 0, []string{}
				emit("health.recovered", obj("status", "healthy", "clearedReasons", strList(cleared)))
			}
		}
	} else {
		st.CleanStreak = 0
		if rank[target] > rank[st.Status] {
			emit("health.degraded", obj("status", target, "reasons", strList(distinct)))
		}
		st.Status = target
		st.LastReasons = append([]string{}, distinct...)
	}
	return Result{Events: events, Status: st.Status, Reasons: distinct}
}
