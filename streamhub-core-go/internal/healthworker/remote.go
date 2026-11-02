package healthworker

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"regexp"
	"strings"
	"time"

	y "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
)

// Remote mode (3.4): every room found on the origin's disk is ALSO probed
// through each configured edge/CDN base — GET <base>/hls/<app>/<room>/
// index.m3u8 — with the same detectors, so the monitor sees what viewers
// receive and not only what the origin wrote. One probe per (room, edge),
// keyed "<room>@<edge>": no on-disk room can take that key (HLS dirs are
// slugged to [A-Za-z0-9_-]). Per remote sample: one playlist GET (≤ 1 MB)
// and — only when a NEW segment appeared — one GET of the newest segment
// (bounded at tsReadCap) into a temp file for ffprobe / CC scan /
// volumedetect. A failed playlist GET is "no advance" (→ stalled after
// stall_sec), never "stream ended": the origin's disk owns the room's life.

const (
	// EdgeBasesKey is the app-level config key (builtins.json configSchema).
	EdgeBasesKey       = "edge_hls_bases"
	remotePlaylistCap  = 1 << 20
	remoteFetchTimeout = 10 * time.Second
	remoteDrainCap     = 64 << 10
)

// EdgeBase is one configured edge/CDN base.
type EdgeBase struct {
	Name string // event `via`, snapshot key suffix
	Base string // scheme://host[:port][/prefix], no trailing slash
}

var (
	edgeSplit   = regexp.MustCompile(`[\s,;]+`)
	edgeNameBad = regexp.MustCompile(`[^A-Za-z0-9._:-]`)
	segExt      = regexp.MustCompile(`^\.[A-Za-z0-9]{1,8}$`)
)

// ParseEdgeBases reads edge_hls_bases: a string of entries separated by
// commas / whitespace (or a JSON list of strings); each entry is "url" or
// "name=url", the name defaulting to the URL's host[:port]. Entries that are
// not absolute http(s) URLs, and repeated names, are dropped.
func ParseEdgeBases(v any) []EdgeBase {
	var raw []string
	switch x := v.(type) {
	case string:
		raw = edgeSplit.Split(x, -1)
	case []any:
		for _, e := range x {
			if s, ok := e.(string); ok {
				raw = append(raw, edgeSplit.Split(s, -1)...)
			}
		}
	}
	out := []EdgeBase{}
	seen := map[string]bool{}
	for _, entry := range raw {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		name, base := "", entry
		if i := strings.Index(entry, "="); i > 0 && !strings.Contains(entry[:i], "://") {
			name, base = entry[:i], entry[i+1:]
		}
		u, err := url.Parse(base)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			continue
		}
		u.RawQuery, u.Fragment = "", ""
		if name == "" {
			name = u.Host
		}
		name = edgeNameBad.ReplaceAllString(name, "_")
		if seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, EdgeBase{Name: name, Base: strings.TrimRight(u.String(), "/")})
	}
	return out
}

// PlaylistURL is the edge URL of one room's live playlist.
func (e EdgeBase) PlaylistURL(app, room string) string {
	return e.Base + "/hls/" + url.PathEscape(app) + "/" + url.PathEscape(room) + "/index.m3u8"
}

// remoteSegmentURL resolves a playlist uri against the playlist URL; "" when
// it points at another scheme/host (the worker only follows the edge itself).
func remoteSegmentURL(playlist, uri string) string {
	if uri == "" {
		return ""
	}
	base, err := url.Parse(playlist)
	if err != nil {
		return ""
	}
	ref, err := url.Parse(uri)
	if err != nil {
		return ""
	}
	u := base.ResolveReference(ref)
	if u.Scheme != base.Scheme || u.Host != base.Host {
		return ""
	}
	return u.String()
}

// fetch GETs u keeping at most limit bytes; size is the Content-Length when
// the server sent a larger one (the bitrate counts the whole segment).
func (w *worker) fetch(ctx context.Context, u string, limit int64) (body []byte, size int64, err error) {
	ctx, cancel := context.WithTimeout(ctx, remoteFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("user-agent", "streamhub-health-worker")
	res, err := w.o.Client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, remoteDrainCap))
		return nil, 0, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, limit))
	if err != nil {
		return nil, 0, err
	}
	size = int64(len(b))
	if res.ContentLength > size {
		size = res.ContentLength
	}
	return b, size, nil
}

// remoteNewest downloads the newest of the new segments that resolves on the
// edge into a temp file (the caller removes it). Only that one segment is
// fetched, so the measured bitrate is its size over its EXTINF seconds.
func (w *worker) remoteNewest(ctx context.Context, playlist string, segs []Segment) (infos []SegInfo, file, uri string) {
	for i := len(segs) - 1; i >= 0; i-- {
		seg := segs[i]
		u := remoteSegmentURL(playlist, seg.URI)
		if u == "" {
			continue
		}
		body, size, err := w.fetch(ctx, u, tsReadCap)
		if err != nil {
			return nil, "", "" // rotated out / edge trouble: no deep probe this cycle
		}
		ext := ""
		if pu, err := url.Parse(u); err == nil && segExt.MatchString(path.Ext(pu.Path)) {
			ext = path.Ext(pu.Path)
		}
		f, err := os.CreateTemp("", "health-remote-*"+ext)
		if err != nil {
			return nil, "", ""
		}
		_, werr := f.Write(body)
		if cerr := f.Close(); werr != nil || cerr != nil {
			_ = os.Remove(f.Name())
			return nil, "", ""
		}
		return []SegInfo{{Bytes: float64(size), Duration: seg.Duration}}, f.Name(), seg.URI
	}
	return nil, "", ""
}

// withVia is a remote probe's event payload: the origin one plus `via`.
func withVia(data *y.Map, via string) *y.Map {
	out := y.NewMap()
	if data != nil {
		out = data.Clone()
	}
	out.Set("via", via)
	return out
}
