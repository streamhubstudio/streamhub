package passthrough

import (
	"regexp"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
)

// MediaMTX publish-path classes (mediamtx-path.util.ts).
const (
	PathPassthrough = "passthrough"
	PathLivekit     = "livekit"
	PathInvalid     = "invalid"
)

// livekitPathPrefix is the LiveKit ingress plane segment (live/<key>).
const livekitPathPrefix = "live"

// PathClass is a classified MediaMTX path; App only for passthrough.
type PathClass struct {
	Kind string
	App  string
	Key  string
}

var (
	twoSeg       = regexp.MustCompile(`^([^/]+)/([^/]+)$`)
	deepLive     = regexp.MustCompile(`^` + livekitPathPrefix + `/(.+)$`)
	leadingSlash = regexp.MustCompile(`^/+`)
)

// ClassifyMediamtxPath routes a publish path: the ptk_ key prefix wins (a
// passthrough push on the app literally named `live` stays passthrough),
// `live/<non-ptk>` (or deeper) is the LiveKit plane, any other two-segment
// path is passthrough, everything else is invalid.
func ClassifyMediamtxPath(raw string) PathClass {
	path := leadingSlash.ReplaceAllString(raw, "")
	if m := twoSeg.FindStringSubmatch(path); m != nil {
		app, key := m[1], m[2]
		if strings.HasPrefix(key, livekit.PassthroughStreamKeyPrefix) {
			return PathClass{Kind: PathPassthrough, App: app, Key: key}
		}
		if app == livekitPathPrefix {
			return PathClass{Kind: PathLivekit, Key: key}
		}
		return PathClass{Kind: PathPassthrough, App: app, Key: key}
	}
	if m := deepLive.FindStringSubmatch(path); m != nil {
		return PathClass{Kind: PathLivekit, Key: m[1]}
	}
	return PathClass{Kind: PathInvalid}
}
