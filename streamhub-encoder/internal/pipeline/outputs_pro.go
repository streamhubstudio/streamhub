package pipeline

import (
	"fmt"
	"net"
	"net/url"
	"path"
	"strings"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
)

// ffmpegIn is the ffmpeg input reading an output's copy of the bus.
func ffmpegIn(busPort int) []string {
	return []string{"-hide_banner", "-loglevel", "warning", "-nostats", "-fflags", "+genpts",
		"-i", fmt.Sprintf("udp://127.0.0.1:%d?fifo_size=1000000&overrun_nonfatal=1&buffer_size=4194304", busPort)}
}

// renditionPID is the TS PID of rendition r (0 = main encode).
func renditionPID(ch config.Channel, r int) int {
	if r == 0 {
		return ch.Mux.VideoPID
	}
	return RenditionPIDBase + r - 1
}

// selectRendition maps one video rendition + the main audio track by PID
// (ffmpeg's stream order inside the TS is not the rendition order).
func selectRendition(ch config.Channel, r int) []string {
	args := []string{"-map", fmt.Sprintf("0:i:%d", renditionPID(ch, r))}
	if !ch.Audio.Disabled {
		args = append(args, "-map", fmt.Sprintf("0:i:%d", ch.Mux.AudioPID))
	}
	return args
}

// buildOutputPro builds the outputs added for the professional feature set:
// HLS (single or ABR ladder, TS or CMAF), single-rendition remuxes, RIST and
// the rolling recording. ok=false → not handled here.
func buildOutputPro(ch config.Channel, o config.Output, busPort int, now time.Time) (Command, bool, error) {
	hevc := ch.Video.Codec == config.CodecH265
	switch {
	case o.Type == config.OutHLS:
		h := o.HLS
		dir := strings.TrimSuffix(o.URL, path.Base(o.URL))
		fmp4 := h.CMAF || hevc
		args := ffmpegIn(busPort)
		segExt := "ts"
		if h.Ladder {
			var vsm []string
			for i := 0; i <= len(ch.Video.Renditions); i++ {
				args = append(args, "-map", fmt.Sprintf("0:i:%d", renditionPID(ch, i)))
				if !ch.Audio.Disabled {
					args = append(args, "-map", fmt.Sprintf("0:i:%d", ch.Mux.AudioPID))
					vsm = append(vsm, fmt.Sprintf("v:%d,a:%d,name:%s", i, i, renditionName(ch, i)))
				} else {
					vsm = append(vsm, fmt.Sprintf("v:%d,name:%s", i, renditionName(ch, i)))
				}
			}
			args = append(args, "-c", "copy")
			if hevc {
				args = append(args, "-tag:v", "hvc1")
			}
			if fmp4 {
				args = append(args, "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init_%v.mp4")
				segExt = "m4s"
			}
			args = append(args, "-f", "hls", "-hls_time", fmt.Sprint(h.SegmentSeconds), "-hls_list_size", fmt.Sprint(h.ListSize),
				"-hls_flags", "independent_segments+omit_endlist+program_date_time", "-method", "PUT", "-http_persistent", "1",
				"-var_stream_map", strings.Join(vsm, " "), "-master_pl_name", path.Base(o.URL), "-master_pl_publish_rate", "2",
				"-hls_segment_filename", dir+"%v/seg_%06d."+segExt, dir+"%v/index.m3u8")
			return Command{Path: FFmpeg, Args: args}, true, nil
		}
		args = append(args, selectRendition(ch, o.Rendition)...)
		args = append(args, "-c", "copy")
		if hevc {
			// Apple requires fMP4 segments + hvc1 tag for HEVC HLS.
			args = append(args, "-tag:v", "hvc1")
		}
		if fmp4 {
			args = append(args, "-hls_segment_type", "fmp4")
			segExt = "m4s"
		}
		args = append(args, "-f", "hls", "-hls_time", fmt.Sprint(h.SegmentSeconds), "-hls_list_size", fmt.Sprint(h.ListSize),
			"-hls_flags", "independent_segments+omit_endlist+program_date_time", "-method", "PUT", "-http_persistent", "1",
			"-hls_segment_filename", dir+"seg_%06d."+segExt, o.URL)
		return Command{Path: FFmpeg, Args: args}, true, nil

	case o.Rendition > 0:
		args := append(ffmpegIn(busPort), selectRendition(ch, o.Rendition)...)
		args = append(args, "-c", "copy")
		switch o.Type {
		case config.OutRTMP:
			args = append(args, "-f", "flv", "-flvflags", "no_duration_filesize", o.URL)
		case config.OutSRT:
			u, _ := url.Parse(o.URL)
			s := o.SRT
			qv := url.Values{}
			qv.Set("mode", s.Mode)
			qv.Set("latency", fmt.Sprint(s.LatencyMs*1000))
			qv.Set("pkt_size", "1316")
			if s.Passphrase != "" {
				qv.Set("passphrase", s.Passphrase)
				qv.Set("pbkeylen", fmt.Sprint(s.PBKeyLen))
			}
			if s.StreamID != "" {
				qv.Set("streamid", s.StreamID)
			}
			args = append(args, "-f", "mpegts", "srt://"+u.Host+"?"+qv.Encode())
		case config.OutUDP:
			ttl := 16
			if o.UDP != nil {
				ttl = o.UDP.TTL
			}
			args = append(args, "-f", "mpegts", fmt.Sprintf("%s?pkt_size=1316&ttl=%d", o.URL, ttl))
		default:
			return Command{}, true, fmt.Errorf("rendition selection is not available for %s outputs", o.Type)
		}
		return Command{Path: FFmpeg, Args: args}, true, nil

	case o.Type == config.OutRIST:
		u, _ := url.Parse(o.URL)
		host, port, _ := net.SplitHostPort(u.Host)
		r := o.RIST
		sink := fmt.Sprintf("ristsink address=%s port=%s sender-buffer=%d", mustQ(host), port, r.BufferMs)
		if len(r.Bonding) > 0 {
			// broadcast bonding: every packet on every link (path redundancy)
			links := append([]string{u.Host}, r.Bonding...)
			sink += " bonding-addresses=" + mustQ(strings.Join(links, ",")) + " bonding-method=broadcast"
		}
		desc := BusSource(busPort) + " ! rtpmp2tpay pt=33 mtu=1316 ! " + sink
		return Command{Path: GstLaunch, Args: LaunchArgs(desc)}, true, nil

	case o.Type == config.OutRecord:
		r := o.Record
		dir := strings.TrimRight(o.URL, "/")
		args := append(ffmpegIn(busPort), "-map", "0", "-c", "copy", "-f", "segment", "-segment_format", "mpegts",
			"-segment_time", fmt.Sprint(r.SegmentSeconds), "-segment_wrap", fmt.Sprint(r.MaxSegments),
			"-segment_list", dir+"/index.csv", "-segment_list_type", "csv", "-segment_list_size", fmt.Sprint(r.MaxSegments),
			dir+"/"+ch.ID+"-%06d.ts")
		return Command{Path: FFmpeg, Args: args}, true, nil
	}
	return Command{}, false, nil
}

func renditionName(ch config.Channel, i int) string {
	if i == 0 {
		return fmt.Sprintf("%dp", ch.Video.Height)
	}
	n := ch.Video.Renditions[i-1].Name
	if n == "" {
		n = fmt.Sprintf("%dp", ch.Video.Renditions[i-1].Height)
	}
	return n
}
