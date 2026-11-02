// Package caps probes what this host can do: which GStreamer elements exist
// (software/hardware encoders, protocol sinks, capture sources) and which
// capture devices/GPUs are present. The result feeds encoder "auto"
// selection, validation of explicit choices and GET /system/capabilities.
package caps

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Elements probed at boot. Keep in sync with what internal/pipeline emits.
var Elements = []string{
	// encoders
	"x264enc", "x265enc", "nvh264enc", "nvh265enc", "qsvh264enc", "qsvh265enc", "vah264enc", "vah265enc",
	// audio
	"avenc_aac", "opusenc", "avdec_aac",
	// inputs
	"fallbacksrc", "fallbackswitch", "decklinkvideosrc", "decklinkaudiosrc", "v4l2src", "alsasrc", "srtsrc", "rtmp2src", "rtspsrc", "udpsrc",
	// outputs / mux
	"mpegtsmux", "tsdemux", "srtsink", "rtmp2sink", "flvmux", "eflvmux", "rtpmp2tpay", "rtph264pay", "rtpopuspay", "udpsink",
	// overlays
	"timecodestamper", "timeoverlay", "clockoverlay", "textoverlay", "deinterlace", "interlace",
}

// Report is the probe result.
type Report struct {
	ProbedAt   time.Time       `json:"probedAt"`
	GstVersion string          `json:"gstVersion"`
	Elements   map[string]bool `json:"elements"`
	Encoders   []EncoderCap    `json:"encoders"`
	Devices    Devices         `json:"devices"`
	FFmpeg     bool            `json:"ffmpeg"`
	Missing    []string        `json:"missing,omitempty"` // required elements that are absent
}

// EncoderCap is one available encoder backend.
type EncoderCap struct {
	Codec    string `json:"codec"`
	Backend  string `json:"backend"`
	Element  string `json:"element"`
	Hardware bool   `json:"hardware"`
}

// Devices lists capture hardware and GPUs.
type Devices struct {
	V4L2     []string `json:"v4l2"`
	DeckLink []string `json:"decklink"`
	GPUs     []string `json:"gpus"`
	DRI      []string `json:"dri"`
}

// Required are the elements without which the encoder cannot work at all.
var Required = []string{"x264enc", "avenc_aac", "mpegtsmux", "tsdemux", "fallbacksrc", "fallbackswitch", "udpsink", "udpsrc", "srtsink"}

// Has implements pipeline.Caps.
func (r *Report) Has(e string) bool { return r != nil && r.Elements[e] }

// Probe inspects the host. gstInspect is the gst-inspect-1.0 path.
func Probe(ctx context.Context, gstInspect, ffmpeg string) *Report {
	r := &Report{ProbedAt: time.Now().UTC(), Elements: map[string]bool{}}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for _, e := range Elements {
		wg.Add(1)
		go func(e string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			c, cancel := context.WithTimeout(ctx, 20*time.Second)
			defer cancel()
			ok := exec.CommandContext(c, gstInspect, "--exists", e).Run() == nil
			mu.Lock()
			r.Elements[e] = ok
			mu.Unlock()
		}(e)
	}
	wg.Wait()
	if out, err := exec.CommandContext(ctx, gstInspect, "--version").Output(); err == nil {
		for _, l := range strings.Split(string(out), "\n") {
			if strings.HasPrefix(l, "GStreamer ") {
				r.GstVersion = strings.TrimPrefix(l, "GStreamer ")
			}
		}
	}
	if _, err := exec.LookPath(ffmpeg); err == nil {
		r.FFmpeg = true
	}
	r.Encoders = Encoders(r.Elements)
	for _, e := range Required {
		if !r.Elements[e] {
			r.Missing = append(r.Missing, e)
		}
	}
	r.Devices = probeDevices(ctx)
	return r
}

// Encoders lists the encoder backends present in an element map.
func Encoders(el map[string]bool) []EncoderCap {
	table := []EncoderCap{
		{"h264", "x264", "x264enc", false}, {"h265", "x265", "x265enc", false},
		{"h264", "nvenc", "nvh264enc", true}, {"h265", "nvenc", "nvh265enc", true},
		{"h264", "qsv", "qsvh264enc", true}, {"h265", "qsv", "qsvh265enc", true},
		{"h264", "vaapi", "vah264enc", true}, {"h265", "vaapi", "vah265enc", true},
	}
	var out []EncoderCap
	for _, t := range table {
		if el[t.Element] {
			out = append(out, t)
		}
	}
	return out
}

func probeDevices(ctx context.Context) Devices {
	var d Devices
	d.V4L2 = glob("/dev/video*")
	d.DeckLink = glob("/dev/blackmagic/*")
	d.DRI = glob("/dev/dri/renderD*")
	c, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(c, "nvidia-smi", "--query-gpu=index,name,memory.total", "--format=csv,noheader").Output(); err == nil {
		for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			if l = strings.TrimSpace(l); l != "" {
				d.GPUs = append(d.GPUs, l)
			}
		}
	}
	return d
}

func glob(p string) []string {
	m, _ := filepath.Glob(p)
	var out []string
	for _, f := range m {
		if _, err := os.Stat(f); err == nil {
			out = append(out, f)
		}
	}
	sort.Strings(out)
	if out == nil {
		out = []string{}
	}
	return out
}
