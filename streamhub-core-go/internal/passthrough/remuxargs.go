// Package passthrough is src/modules/passthrough: the RTMP/SRT/MPEG-TS → HLS
// remux plane (ffmpeg -c copy, no transcode), its auth gate, the boot re-arm
// front and the loopback-only MediaMTX single-port hook sink.
package passthrough

import (
	"path/filepath"
	"strconv"
)

// Transports of a passthrough ingress: rtmp/srt are push listeners (ffmpeg
// is the acceptor), mpegts is a PULL from a udp:// source.
const (
	TransportRTMP   = "rtmp"
	TransportSRT    = "srt"
	TransportMPEGTS = "mpegts"
)

const (
	// SrtLatencyMs is libsrt's default receive latency (capability note).
	SrtLatencyMs = 120
	// HlsPlaylist is the playlist filename in the room's HLS dir.
	HlsPlaylist = "index.m3u8"
	hlsTime     = 4
	hlsListSize = 6
	// listenHost binds the -listen acceptor; pullHost is the front MediaMTX.
	listenHost = "0.0.0.0"
	pullHost   = "127.0.0.1"
)

// HlsDir is <dataDir>/apps/<app>/hls/<room>/ (what /hls/<app>/<room>/ serves).
func HlsDir(dataDir, app, room string) string {
	return filepath.Join(dataDir, "apps", app, "hls", room)
}

// RemuxArgs are the inputs of BuildRemuxArgs (zero values = Node defaults).
type RemuxArgs struct {
	App       string
	StreamKey string
	Port      int
	HlsDir    string
	Transport string // rtmp (default) | srt | mpegts
	Mode      string // listen (default) | pull
	SourceURL string // mpegts only
	BindHost  string
	PullHost  string
	HlsTime   int
	ListSize  int
}

// BuildRemuxArgs is the ffmpeg argv (without the binary) of a passthrough
// remux — deterministic, byte-identical to Node's buildRemuxArgs.
func BuildRemuxArgs(o RemuxArgs) []string {
	bind := or(o.BindHost, listenHost)
	t := o.HlsTime
	if t == 0 {
		t = hlsTime
	}
	ls := o.ListSize
	if ls == 0 {
		ls = hlsListSize
	}
	var input []string
	switch {
	case o.Transport == TransportMPEGTS:
		// PULL: connect OUT to the multicast group / unicast port; -f mpegts
		// forces the demuxer so a silent group never mis-probes.
		input = []string{"-f", "mpegts", "-i", o.SourceURL}
	case o.Mode == "pull":
		// PULL off the front MediaMTX (single-port switch, RTMP only).
		input = []string{"-i", "rtmp://" + or(o.PullHost, pullHost) + ":" + strconv.Itoa(o.Port) + "/" + o.App + "/" + o.StreamKey}
	case o.Transport == TransportSRT:
		input = []string{"-i", "srt://" + bind + ":" + strconv.Itoa(o.Port) + "?mode=listener"}
	default:
		// ffmpeg is the RTMP acceptor — listen for ONE push.
		input = []string{"-listen", "1", "-i", "rtmp://" + bind + ":" + strconv.Itoa(o.Port) + "/" + o.App + "/" + o.StreamKey}
	}
	args := append([]string{"-hide_banner", "-loglevel", "warning"}, input...)
	return append(args,
		"-c", "copy",
		"-f", "hls",
		"-hls_time", strconv.Itoa(t),
		"-hls_list_size", strconv.Itoa(ls),
		"-hls_flags", "delete_segments+append_list",
		"-hls_segment_filename", filepath.Join(o.HlsDir, "seg_%05d.ts"),
		filepath.Join(o.HlsDir, HlsPlaylist),
	)
}

// BuildForwardArgs is the argv of the LiveKit-plane FORWARD hop: pull
// live/<key> off MediaMTX and push FLV to the moved LiveKit ingress.
func BuildForwardArgs(key string, sourcePort, destPort int, host string) []string {
	host = or(host, pullHost)
	return []string{
		"-hide_banner", "-loglevel", "warning",
		"-i", "rtmp://" + host + ":" + strconv.Itoa(sourcePort) + "/live/" + key,
		"-c", "copy",
		"-f", "flv",
		"rtmp://" + host + ":" + strconv.Itoa(destPort) + "/live/" + key,
	}
}

func or(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
