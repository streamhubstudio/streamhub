package config

// Rendition is one rung of an ABR ladder.
type Rendition struct {
	Name        string `json:"name,omitempty"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	BitrateKbps int    `json:"bitrateKbps"`
}

// AudioTrack is an extra audio track (another language or channel group).
type AudioTrack struct {
	Lang        string `json:"lang,omitempty"` // ISO 639-2, e.g. "eng"
	Channels    int    `json:"channels,omitempty"`
	Map         []int  `json:"map,omitempty"` // input channels (DeckLink/test inputs)
	BitrateKbps int    `json:"bitrateKbps,omitempty"`
	Codec       string `json:"codec,omitempty"` // aac|ac3|mp2 (default: main track codec)
}

// SCTE35Options configures cue insertion.
type SCTE35Options struct {
	Enabled      bool `json:"enabled"`
	PID          int  `json:"pid,omitempty"`          // default 500 (0x1F4)
	HeartbeatSec int  `json:"heartbeatSec,omitempty"` // splice_null every N s (0 = off)
}

// AlarmOptions tunes the confidence-monitoring alarms of a channel.
type AlarmOptions struct {
	Disabled       []string `json:"disabled,omitempty"`       // alarm types to ignore
	BlackSec       int      `json:"blackSec,omitempty"`       // default 5
	FreezeSec      int      `json:"freezeSec,omitempty"`      // default 10
	SilenceSec     int      `json:"silenceSec,omitempty"`     // default 10
	SilenceDBFS    float64  `json:"silenceDbfs,omitempty"`    // default -60
	BitrateDropPct int      `json:"bitrateDropPct,omitempty"` // alarm under this % of the video target (default 20)
	LoudnessTarget float64  `json:"loudnessTarget,omitempty"` // LUFS: -23 (EBU R128), -24 (ATSC A/85); 0 = off
	LoudnessTolLU  float64  `json:"loudnessTolLu,omitempty"`  // default 3
}

// RISTOptions for rist outputs (rist://host:port, even port).
type RISTOptions struct {
	Bonding  []string `json:"bonding,omitempty"`  // extra host:port links (bonding / path redundancy)
	BufferMs int      `json:"bufferMs,omitempty"` // retransmission buffer, default 1000
}

// RecordOptions for the rolling local recording (URL = absolute directory).
type RecordOptions struct {
	SegmentSeconds int `json:"segmentSeconds,omitempty"` // default 60
	MaxSegments    int `json:"maxSegments,omitempty"`    // ring size, default 60 (1 h)
}

// Alarm types.
const (
	AlarmInputLoss   = "input_loss" // black + silence together (fallback dummy / lost feed)
	AlarmBlack       = "black"
	AlarmFreeze      = "freeze"
	AlarmSilence     = "silence"
	AlarmBitrateDrop = "bitrate_drop"
	AlarmEngineDown  = "engine_down"
	AlarmOutputDown  = "output_down"
	AlarmLoudness    = "loudness"
)

// AlarmDefaults returns the effective alarm options of a channel.
func (c *Channel) AlarmDefaults() AlarmOptions {
	a := AlarmOptions{}
	if c.Alarms != nil {
		a = *c.Alarms
	}
	if a.BlackSec == 0 {
		a.BlackSec = 5
	}
	if a.FreezeSec == 0 {
		a.FreezeSec = 10
	}
	if a.SilenceSec == 0 {
		a.SilenceSec = 10
	}
	if a.SilenceDBFS == 0 {
		a.SilenceDBFS = -60
	}
	if a.BitrateDropPct == 0 {
		a.BitrateDropPct = 20
	}
	if a.LoudnessTolLU == 0 {
		a.LoudnessTolLU = 3
	}
	return a
}

// AlarmEnabled reports whether an alarm type is active for the channel.
func (a AlarmOptions) AlarmEnabled(t string) bool {
	for _, d := range a.Disabled {
		if d == t {
			return false
		}
	}
	return true
}
