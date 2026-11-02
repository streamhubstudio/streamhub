// Package whip is a WHIP (RFC 9725) publisher built on pion/webrtc (pure
// Go). It forwards ready-made RTP — H.264 and Opus packetised by the GStreamer
// helper of the WHIP output — to a WebRTC peer negotiated with one HTTP POST.
package whip

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// Options configure a publish session.
type Options struct {
	URL    string
	Bearer string
	Video  net.PacketConn // H.264 RTP in
	Audio  net.PacketConn // Opus RTP in (nil = video only)
	HTTP   *http.Client
	Log    *slog.Logger
	// ICEServers (STUN/TURN) for NATed paths; empty works for public SFUs
	// that answer with ICE-lite host candidates (LiveKit, MediaMTX).
	ICEServers []string
}

// Negotiate does the WHIP offer/answer exchange. It is split out so tests can
// exercise the signalling against an httptest server.
func Negotiate(ctx context.Context, hc *http.Client, endpoint, bearer, offer string) (answer, location string, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(offer))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/sdp")
	req.Header.Set("Accept", "application/sdp")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := hc.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("WHIP POST %s: HTTP %d: %s", endpoint, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if !bytes.Contains(body, []byte("v=0")) {
		return "", "", errors.New("WHIP answer is not an SDP")
	}
	loc := resp.Header.Get("Location")
	if loc != "" {
		if u, err := url.Parse(loc); err == nil {
			base, _ := url.Parse(endpoint)
			loc = base.ResolveReference(u).String()
		}
	}
	return string(body), loc, nil
}

// Teardown sends the WHIP DELETE on the resource URL (best effort).
func Teardown(hc *http.Client, location, bearer string) {
	if location == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, location, nil)
	if err != nil {
		return
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if resp, err := hc.Do(req); err == nil {
		resp.Body.Close()
	}
}

// Publish runs one session until ctx ends or the peer connection fails.
func Publish(ctx context.Context, o Options) error {
	log := o.Log
	if log == nil {
		log = slog.Default()
	}
	hc := o.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 15 * time.Second}
	}
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		return err
	}
	ir := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(m, ir); err != nil {
		return err
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(ir))
	var ice []webrtc.ICEServer
	for _, s := range o.ICEServers {
		ice = append(ice, webrtc.ICEServer{URLs: []string{s}})
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{ICEServers: ice, BundlePolicy: webrtc.BundlePolicyMaxBundle})
	if err != nil {
		return err
	}
	defer pc.Close()

	vt, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000,
		SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"}, "video", "streamhub-encoder")
	if err != nil {
		return err
	}
	if err := addSendOnly(pc, vt); err != nil {
		return err
	}
	var at *webrtc.TrackLocalStaticRTP
	if o.Audio != nil {
		at, err = webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2,
			SDPFmtpLine: "minptime=10;useinbandfec=1"}, "audio", "streamhub-encoder")
		if err != nil {
			return err
		}
		if err := addSendOnly(pc, at); err != nil {
			return err
		}
	}

	failed := make(chan error, 1)
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		log.Info("whip: peer connection", "state", s.String())
		switch s {
		case webrtc.PeerConnectionStateFailed:
			select {
			case failed <- errors.New("peer connection failed"):
			default:
			}
		case webrtc.PeerConnectionStateClosed:
			select {
			case failed <- errors.New("peer connection closed"):
			default:
			}
		}
	})

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return err
	}
	gather := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		return err
	}
	select {
	case <-gather:
	case <-time.After(5 * time.Second): // send what we have (host candidates)
	case <-ctx.Done():
		return ctx.Err()
	}
	nctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	answer, location, err := Negotiate(nctx, hc, o.URL, o.Bearer, pc.LocalDescription().SDP)
	cancel()
	if err != nil {
		return err
	}
	defer Teardown(hc, location, o.Bearer)
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		return fmt.Errorf("bad WHIP answer: %w", err)
	}
	log.Info("whip: negotiated", "resource", location)

	fwdErr := make(chan error, 2)
	go func() { fwdErr <- forward(ctx, o.Video, vt) }()
	if at != nil {
		go func() { fwdErr <- forward(ctx, o.Audio, at) }()
	}
	// Connected-or-bust: a session that never connects is a failure.
	connected := make(chan struct{})
	go func() {
		t := time.NewTicker(200 * time.Millisecond)
		defer t.Stop()
		for {
			if pc.ConnectionState() == webrtc.PeerConnectionStateConnected {
				close(connected)
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
	select {
	case <-connected:
	case <-time.After(20 * time.Second):
		return errors.New("ICE/DTLS did not connect within 20 s")
	case err := <-failed:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
	// Disconnected for long → give up so the supervisor renegotiates.
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-failed:
			return err
		case err := <-fwdErr:
			return fmt.Errorf("rtp forward: %w", err)
		case <-time.After(time.Second):
			if pc.ConnectionState() == webrtc.PeerConnectionStateDisconnected {
				deadline := time.Now().Add(10 * time.Second)
				for pc.ConnectionState() == webrtc.PeerConnectionStateDisconnected && time.Now().Before(deadline) {
					time.Sleep(250 * time.Millisecond)
				}
				if pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
					return errors.New("peer disconnected for 10 s")
				}
			}
		}
	}
}

func addSendOnly(pc *webrtc.PeerConnection, t webrtc.TrackLocal) error {
	tr, err := pc.AddTransceiverFromTrack(t, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		return err
	}
	go func() { // drain RTCP so interceptors (NACK, reports) work
		buf := make([]byte, 1500)
		for {
			if _, _, err := tr.Sender().Read(buf); err != nil {
				return
			}
		}
	}()
	return nil
}

func forward(ctx context.Context, c net.PacketConn, t *webrtc.TrackLocalStaticRTP) error {
	buf := make([]byte, 1600)
	var p rtp.Packet
	for {
		if ctx.Err() != nil {
			return nil
		}
		_ = c.SetReadDeadline(time.Now().Add(30 * time.Second))
		n, _, err := c.ReadFrom(buf)
		if err != nil {
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				return errors.New("no RTP from the helper for 30 s")
			}
			return err
		}
		if err := p.Unmarshal(buf[:n]); err != nil {
			continue
		}
		if err := t.WriteRTP(&p); err != nil && !errors.Is(err, io.ErrClosedPipe) {
			return err
		}
	}
}
