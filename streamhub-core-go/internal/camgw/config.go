// Package camgw turns standard RTSP/ONVIF cameras into OpenCam devices: each
// configured camera speaks the StreamHub camera contract (opencameras
// docs/STREAMHUB.md, api: 1) over MQTT — retained hello/status/state, event
// lines, uniform command answers — while the gateway does the camera's work:
// one ffmpeg per camera (a single RTSP session, stream-copied) feeds the RTMP
// ingest and/or MP4 segments, snapshots go to the upload webhook, and PTZ is
// driven over ONVIF. It is the core of cmd/streamhub-agent.
package camgw

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Config is the gateway file (JSON).
type Config struct {
	ID            string   `json:"id"`               // gateway id, used in logs and hello.image
	DataDir       string   `json:"data_dir"`         // recordings root (one dir per device)
	FFmpeg        string   `json:"ffmpeg"`           // ffmpeg binary (default "ffmpeg" on PATH)
	StateInterval int      `json:"state_interval_s"` // default 30
	DiskHighPct   int      `json:"disk_high_pct"`    // start deleting oldest segments (default 90)
	DiskLowPct    int      `json:"disk_low_pct"`     // stop deleting (default 85)
	Cameras       []Camera `json:"cameras"`

	Dir string `json:"-"` // directory of the config file (per-device overlays live here)
}

// Camera is one RTSP/ONVIF camera behind the gateway.
type Camera struct {
	Name       string `json:"name"`
	RTSP       string `json:"rtsp"`     // main stream (source 0)
	RTSPSub    string `json:"rtsp_sub"` // sub stream (source 1); empty = main only
	ONVIF      *ONVIF `json:"onvif"`    // optional: PTZ
	Record     bool   `json:"record"`   // MP4 segments under data_dir
	Audio      string `json:"audio"`    // auto (default) | copy | aac | off
	SegmentMin int    `json:"segment_min"`
	// CredentialsFile is the JSON the cloud hands out at enrolment (the same
	// payload as the camera's QR: device, stream, mqtt, upload.webhook). Its
	// fields can also be given inline below.
	CredentialsFile string `json:"credentials"`
	Credentials
}

// ONVIF endpoint of a camera.
type ONVIF struct {
	URL  string `json:"url"` // device service, e.g. http://10.0.0.5/onvif/device_service
	User string `json:"user"`
	Pass string `json:"pass"`
}

// Credentials is the enrolment payload (cloud enrolment JSON, OpenCam QR).
type Credentials struct {
	Device struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"device"`
	Stream struct {
		Enabled string `json:"enabled"`
		URL     string `json:"url"`
		Key     string `json:"key"`
		Source  string `json:"source"`
	} `json:"stream"`
	MQTT struct {
		Enabled   string `json:"enabled"`
		Host      string `json:"host"`
		Port      string `json:"port"`
		TLS       string `json:"tls"`
		Username  string `json:"username"`
		Password  string `json:"password"`
		BaseTopic string `json:"base_topic"`
	} `json:"mqtt"`
	Webhook struct {
		URL   string `json:"url"`
		Token string `json:"token"`
	} `json:"upload.webhook"`
}

func truthy(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// Load reads and validates the gateway file; credentials files are relative
// to it.
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	c.Dir = filepath.Dir(path)
	if c.FFmpeg == "" {
		c.FFmpeg = "ffmpeg"
	}
	if c.StateInterval <= 0 {
		c.StateInterval = 30
	}
	if c.DiskHighPct <= 0 {
		c.DiskHighPct = 90
	}
	if c.DiskLowPct <= 0 || c.DiskLowPct >= c.DiskHighPct {
		c.DiskLowPct = c.DiskHighPct - 5
	}
	if len(c.Cameras) == 0 {
		return nil, errors.New("no cameras configured")
	}
	seen := map[string]bool{}
	for i := range c.Cameras {
		cam := &c.Cameras[i]
		if cam.CredentialsFile != "" {
			p := cam.CredentialsFile
			if !filepath.IsAbs(p) {
				p = filepath.Join(filepath.Dir(path), p)
			}
			b, err := os.ReadFile(p)
			if err != nil {
				return nil, fmt.Errorf("camera %d: %w", i, err)
			}
			if err := json.Unmarshal(b, &cam.Credentials); err != nil {
				return nil, fmt.Errorf("camera %d: %s: %w", i, p, err)
			}
		}
		id := cam.Device.ID
		switch {
		case id == "":
			return nil, fmt.Errorf("camera %d: device.id is required", i)
		case seen[id]:
			return nil, fmt.Errorf("camera %d: duplicate device %q", i, id)
		case cam.RTSP == "":
			return nil, fmt.Errorf("camera %s: rtsp is required", id)
		}
		seen[id] = true
		if cam.Name == "" {
			cam.Name = cam.Device.Name
		}
		if cam.SegmentMin <= 0 {
			cam.SegmentMin = 30
		}
		if cam.Record && c.DataDir == "" {
			return nil, fmt.Errorf("camera %s: record needs data_dir", id)
		}
	}
	return &c, nil
}

// TopicBase is <root>/<device> from mqtt.base_topic ("tv/abc/%device").
func (c *Camera) TopicBase() string {
	b := c.MQTT.BaseTopic
	if b == "" {
		b = "opencam/%device"
	}
	return strings.TrimSuffix(strings.ReplaceAll(b, "%device", c.Device.ID), "/")
}

// PushURL is the RTMP destination (stream.url + "/" + stream.key).
func (c *Camera) PushURL() string {
	if c.Stream.URL == "" || c.Stream.Key == "" {
		return ""
	}
	return strings.TrimSuffix(c.Stream.URL, "/") + "/" + c.Stream.Key
}
