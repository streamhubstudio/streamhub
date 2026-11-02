package pipeline

import (
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
)

// Command is a process to run.
type Command struct {
	Path string   // "gst-launch-1.0", "ffmpeg" or "@self" (the encoderd binary)
	Args []string // argv without the binary
	Env  []string // extra KEY=VALUE (secrets travel here, not in argv, when the tool allows)
}

// Binaries used by the builders (overridable by the caller).
const (
	GstLaunch = "gst-launch-1.0"
	FFmpeg    = "ffmpeg"
	Self      = "@self"
)

// BusSource is the head every GStreamer output starts with: the channel's
// TS bus datagrams on 127.0.0.1:port, behind a leaky queue so a slow network
// sink drops its own data instead of back-pressuring anything.
func BusSource(port int) string {
	return fmt.Sprintf(`udpsrc address=127.0.0.1 port=%d buffer-size=4194304 caps="video/mpegts,systemstream=(boolean)true,packetsize=(int)188" ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=3000000000 leaky=downstream`, port)
}

// BuildOutput builds the process of one (concrete, non-streamhub) output
// reading the bus on 127.0.0.1:busPort. now is used for file names.
func BuildOutput(ch config.Channel, o config.Output, busPort int, now time.Time) (Command, error) {
	if errs := o.Validate(&ch); len(errs) > 0 {
		return Command{}, errs
	}
	src := BusSource(busPort)
	gst := func(desc string) Command { return Command{Path: GstLaunch, Args: LaunchArgs(desc)} }
	if cmd, ok, err := buildOutputPro(ch, o, busPort, now); ok || err != nil {
		return cmd, err
	}
	switch o.Type {
	case config.OutSRT:
		u, _ := url.Parse(o.URL)
		s := o.SRT
		target := "srt://" + u.Host // query params are expressed as properties below
		desc := fmt.Sprintf("%s ! srtsink uri=%s mode=%s latency=%d wait-for-connection=false sync=false", src, mustQ(target), s.Mode, s.LatencyMs)
		if s.Passphrase != "" {
			pp, err := q(s.Passphrase)
			if err != nil {
				return Command{}, err
			}
			desc += fmt.Sprintf(" passphrase=%s pbkeylen=%d", pp, s.PBKeyLen)
		}
		if s.StreamID != "" {
			sid, err := q(s.StreamID)
			if err != nil {
				return Command{}, err
			}
			desc += " streamid=" + sid
		}
		return gst(desc), nil

	case config.OutUDP, config.OutRTP:
		u, _ := url.Parse(o.URL)
		host, port, _ := net.SplitHostPort(u.Host)
		sink := fmt.Sprintf("udpsink host=%s port=%s sync=false async=false", mustQ(host), port)
		ttl := 16
		if o.UDP != nil {
			ttl = o.UDP.TTL
		}
		if ip := net.ParseIP(host); ip != nil && ip.IsMulticast() {
			sink += fmt.Sprintf(" auto-multicast=true ttl-mc=%d", ttl)
			if o.UDP != nil && o.UDP.Iface != "" {
				sink += " multicast-iface=" + mustQ(o.UDP.Iface)
			}
		} else {
			sink += fmt.Sprintf(" ttl=%d", ttl)
		}
		if o.UDP != nil && o.UDP.Bind != "" {
			sink += " bind-address=" + mustQ(o.UDP.Bind)
		}
		if o.Type == config.OutRTP {
			return gst(src + " ! rtpmp2tpay pt=33 mtu=1400 ! " + sink), nil
		}
		return gst(src + " ! " + sink), nil

	case config.OutRTMP:
		loc, err := q(o.URL)
		if err != nil {
			return Command{}, err
		}
		if ch.Video.Codec == config.CodecH265 {
			// HEVC over Enhanced RTMP (FourCC hvc1): ffmpeg's FLV muxer. GStreamer's
			// eflvmux output was rejected by MediaMTX 1.19 ("unsupported video codec")
			// in e2e, ffmpeg's is accepted (YouTube, MediaMTX, recent Wowza/Ant Media).
			args := []string{"-hide_banner", "-loglevel", "warning", "-nostats", "-fflags", "+genpts",
				"-i", fmt.Sprintf("udp://127.0.0.1:%d?fifo_size=1000000&overrun_nonfatal=1&buffer_size=4194304", busPort),
				"-map", "0:v", "-map", "0:a?", "-c", "copy", "-f", "flv", "-flvflags", "no_duration_filesize", o.URL}
			return Command{Path: FFmpeg, Args: args}, nil
		}
		desc := fmt.Sprintf("%s ! tsdemux name=d latency=200  d. ! video/x-h264 ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=2000000000 ! h264parse ! flvmux name=m streamable=true latency=200000000 ! rtmp2sink location=%s async-connect=false sync=false",
			src, loc)
		if !ch.Audio.Disabled {
			desc += "  d. ! audio/mpeg ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=2000000000 ! aacparse ! m."
		}
		return gst(desc), nil

	case config.OutWHIP:
		args := []string{"whip-push", "--bus-port", fmt.Sprint(busPort), "--url", o.URL}
		if ch.Audio.Disabled {
			args = append(args, "--no-audio")
		}
		var env []string
		if o.WHIP != nil && o.WHIP.BearerToken != "" {
			env = append(env, "ENCODERD_WHIP_BEARER="+o.WHIP.BearerToken)
		}
		return Command{Path: Self, Args: args, Env: env}, nil

	case config.OutFile:
		p := strings.ReplaceAll(o.URL, "{ts}", now.UTC().Format("20060102T150405Z"))
		return gst(src + " ! filesink location=" + mustQ(p) + " sync=false async=false"), nil
	}
	return Command{}, fmt.Errorf("output type %q has no process builder (streamhub outputs must be resolved first)", o.Type)
}

// WHIPHelper is the GStreamer half of a WHIP output: it depacketizes the bus
// TS into H.264 RTP (pt 96) and Opus RTP (pt 111) on two loopback ports, which
// encoderd's pion-based WHIP client forwards to the WebRTC peer.
func WHIPHelper(busPort, videoPort, audioPort int, audio bool) string {
	desc := fmt.Sprintf("%s ! tsdemux name=d latency=100  d. ! video/x-h264 ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=2000000000 ! h264parse config-interval=-1 ! video/x-h264,stream-format=byte-stream,alignment=au ! rtph264pay config-interval=-1 pt=96 mtu=1200 aggregate-mode=zero-latency ! udpsink host=127.0.0.1 port=%d sync=false async=false",
		BusSource(busPort), videoPort)
	if audio {
		desc += fmt.Sprintf("  d. ! audio/mpeg ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=2000000000 ! aacparse ! avdec_aac ! audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=2 ! opusenc bitrate=96000 frame-size=20 ! rtpopuspay pt=111 mtu=1200 ! udpsink host=127.0.0.1 port=%d sync=false async=false", audioPort)
	}
	return desc
}
