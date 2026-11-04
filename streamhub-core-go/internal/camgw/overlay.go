package camgw

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// The cloud reconfigures a camera with config/import (several sections at
// once) or config/set (one dotted key). The gateway keeps those changes as a
// per-device overlay next to its config file, so a restart does not undo them
// — notably upload.webhook: the cloud rotates the snapshot token there.

var errConflict = errors.New("config_rev mismatch")

func (d *Device) overlayPath() string {
	return filepath.Join(d.cfg.Dir, d.cam.Device.ID+".overlay.json")
}

// loadOverlay applies the saved overlay at start.
func (d *Device) loadOverlay() {
	b, err := os.ReadFile(d.overlayPath())
	if err != nil {
		return
	}
	var o struct {
		Rev    int64          `json:"config_rev"`
		Config map[string]any `json:"config"`
	}
	if json.Unmarshal(b, &o) != nil {
		return
	}
	d.mu.Lock()
	d.overlay, d.configRev = o.Config, max(o.Rev, 1)
	d.mu.Unlock()
	d.applyKnown(o.Config)
}

func (d *Device) applyConfig(patch map[string]any, ifRev any) (int64, error) {
	d.mu.Lock()
	if r, ok := ifRev.(float64); ok && int64(r) != d.configRev {
		cur := d.configRev
		d.mu.Unlock()
		return 0, fmt.Errorf("%w: config_rev is %d", errConflict, cur)
	}
	if d.overlay == nil {
		d.overlay = map[string]any{}
	}
	merge(d.overlay, patch)
	d.configRev++
	rev, snapshot := d.configRev, d.overlay
	b, _ := json.MarshalIndent(map[string]any{"config_rev": rev, "config": snapshot}, "", " ")
	d.mu.Unlock()
	if d.cfg.Dir != "" {
		tmp := d.overlayPath() + ".tmp"
		if err := os.WriteFile(tmp, b, 0o600); err == nil {
			_ = os.Rename(tmp, d.overlayPath())
		}
	}
	d.applyKnown(patch)
	return rev, nil
}

// applyKnown maps the OpenCam sections the gateway implements; the rest is
// kept (and reported by config/get) but has no effect on an RTSP camera.
func (d *Device) applyKnown(c map[string]any) {
	if w, ok := getPath(c, "upload.webhook").(map[string]any); ok {
		if u, _ := w["url"].(string); u != "" {
			d.cam.Webhook.URL = u
		}
		if t, _ := w["token"].(string); t != "" {
			d.cam.Webhook.Token = t
		}
	}
	restart := false
	if st, ok := c["stream"].(map[string]any); ok {
		if u, _ := st["url"].(string); u != "" {
			d.cam.Stream.URL, restart = u, true
		}
		if k, _ := st["key"].(string); k != "" && k != "********" {
			d.cam.Stream.Key, restart = k, true
		}
	}
	if restart {
		d.pipe.Restart()
	}
}

func merge(dst, src map[string]any) {
	for k, v := range src {
		if sm, ok := v.(map[string]any); ok {
			dm, ok := dst[k].(map[string]any)
			if !ok {
				dm = map[string]any{}
				dst[k] = dm
			}
			merge(dm, sm)
			continue
		}
		dst[k] = v
	}
}

func setPath(m map[string]any, key string, v any) {
	parts := strings.Split(key, ".")
	for _, p := range parts[:len(parts)-1] {
		n, ok := m[p].(map[string]any)
		if !ok {
			n = map[string]any{}
			m[p] = n
		}
		m = n
	}
	m[parts[len(parts)-1]] = v
}

func getPath(m map[string]any, key string) any {
	var cur any = m
	for _, p := range strings.Split(key, ".") {
		mm, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = mm[p]
	}
	return cur
}
