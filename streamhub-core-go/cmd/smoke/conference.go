package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/devtools/cdp"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/samples"
)

// conferenceCtx renders conference.html the way the samples service does.
var conferenceCtx = map[string]string{
	"APP":         "demo",
	"ROOM":        "standup",
	"WS_URL":      "wss://media.example.invalid/ws",
	"API_URL":     "https://demo.example.invalid/api/v1",
	"ADAPTOR_URL": "https://demo.example.invalid/sdk/streamhub-adaptor.global.js",
	"HLS_URL":     "https://demo.example.invalid/hls/demo",
}

// lkStub stands in for the LiveKit UMD bundle so the page's <script src>
// resolves offline; the pre-join screen never touches it.
const lkStub = `window.LivekitClient={Room:function(){},RoomEvent:{},` +
	`Track:{Source:{Camera:"camera",Microphone:"microphone",ScreenShare:"screen_share"}}};`

// prejoinChecks is evaluated in the page (same probes as the Node smoke).
const prejoinChecks = `(() => {
  const vis = (sel) => { const el = document.querySelector(sel); if (!el) return false;
    const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const call = document.getElementById('call');
  return {
    brand: (document.querySelector('.topbar .brand') || {}).textContent || '',
    heading: (document.querySelector('.pjcard h1') || {}).textContent || '',
    prejoinVisible: vis('#prejoin'),
    nameInput: !!document.getElementById('fName'),
    roomInput: !!document.getElementById('fRoom'),
    joinBtn: (document.getElementById('join') || {}).textContent || '',
    camSelect: !!document.getElementById('camSelect'),
    micSelect: !!document.getElementById('micSelect'),
    camOptions: (document.getElementById('camSelect') || { options: [] }).options.length,
    micOptions: (document.getElementById('micSelect') || { options: [] }).options.length,
    netStatus: (document.getElementById('netlbl') || {}).textContent || '',
    preview: !!document.getElementById('preview'),
    callHidden: !call || getComputedStyle(call).display === 'none',
    controls: ['mic', 'cam', 'screen', 'chatToggle', 'leave'].every((id) => !!document.getElementById(id)),
    roomFromUrl: (document.getElementById('roomName') || {}).textContent || '',
  };
})()`

type prejoin struct {
	Brand, Heading, JoinBtn, NetStatus, RoomFromURL string
	PrejoinVisible, NameInput, RoomInput            bool
	CamSelect, MicSelect, Preview, CallHidden       bool
	Controls                                        bool
	CamOptions, MicOptions                          int
}

// runConference is scripts/conference-smoke.mjs: render the Meet-style
// conference sample, serve it locally, drive it with headless Chrome and
// assert the PRE-JOIN screen (needs no LiveKit; the CDN bundle is stubbed and
// every other external host blocked). Exit 0 pass, 1 fail, 2 no Chrome.
func runConference(args []string) int {
	fs := flag.NewFlagSet("conference", flag.ContinueOnError)
	shot := fs.String("screenshot", envOr("SMOKE_SCREENSHOT", filepath.Join(os.TempDir(), "conference-prejoin.png")), "screenshot output path")
	chrome := fs.String("chrome", cdp.FindChrome(), "Chrome/Chromium binary ($CHROME_PATH / $PUPPETEER_EXECUTABLE_PATH)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *chrome == "" {
		fmt.Fprintln(os.Stderr, "No Chrome binary found. Set CHROME_PATH to your Chrome/Chromium.")
		return 2
	}
	html := samples.RenderPlaceholders(samples.Templates["conference.html"], conferenceCtx)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(html))
	})}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()
	origin := "http://" + ln.Addr().String()

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	failed := false
	fail := func(msg string) { failed = true; fmt.Fprintln(os.Stderr, "FAIL: "+msg) }
	err = func() error {
		b, err := cdp.Launch(ctx, *chrome, "--no-sandbox", "--use-fake-ui-for-media-stream",
			"--use-fake-device-for-media-stream", "--window-size=1280,800")
		if err != nil {
			return err
		}
		defer b.Close()
		p, err := b.NewPage(ctx)
		if err != nil {
			return err
		}
		defer p.Close()
		pageErrors, err := p.CollectErrors(ctx, nil)
		if err != nil {
			return err
		}
		if err := p.SetViewport(ctx, 1280, 800); err != nil {
			return err
		}
		// Stub the LiveKit CDN; allow our own origin; block everything else.
		if err := p.Intercept(ctx, func(r cdp.Request) (string, string, bool, bool) {
			switch {
			case strings.Contains(r.URL, "livekit-client"):
				return lkStub, "application/javascript", true, false
			case strings.HasPrefix(r.URL, origin), strings.HasPrefix(r.URL, "data:"):
				return "", "", false, true
			}
			return "", "", false, false
		}); err != nil {
			return err
		}
		if err := p.Navigate(ctx, origin+"/conference.html"); err != nil {
			return err
		}
		if err := p.WaitTrue(ctx, `(() => { const e = document.querySelector('#prejoin'); if (!e) return false;
		  const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 })()`, 15*time.Second, 200*time.Millisecond); err != nil {
			return err
		}
		time.Sleep(1200 * time.Millisecond) // let the preview / device enumeration settle

		var c prejoin
		if err := p.Eval(ctx, prejoinChecks, &c); err != nil {
			return err
		}
		assert := func(cond bool, label string) {
			if cond {
				fmt.Println("OK   " + label)
			} else {
				fail(label)
			}
		}
		assert(strings.TrimSpace(c.Brand) == "StreamHub", "brand wordmark = StreamHub")
		assert(strings.Contains(strings.ToLower(c.Heading), "ready to join"), "pre-join heading rendered")
		assert(c.PrejoinVisible, "pre-join screen is visible")
		assert(c.NameInput, "display-name input present")
		assert(c.RoomInput, "room input present")
		assert(strings.Contains(strings.ToLower(c.JoinBtn), "join"), "join button present")
		assert(c.CamSelect, "camera device picker present")
		assert(c.MicSelect, "microphone device picker present")
		assert(c.Preview, "camera preview element present")
		assert(strings.TrimSpace(c.NetStatus) != "", fmt.Sprintf("pre-join media path ran (status: %q)", strings.TrimSpace(c.NetStatus)))
		fmt.Printf("INFO device options detected: cam=%d mic=%d (0 is expected on hosts with no enumerable devices)\n", c.CamOptions, c.MicOptions)
		assert(c.CallHidden, "in-call surface hidden before joining")
		assert(c.Controls, "control bar (mic/cam/screen/chat/leave) in DOM")
		assert(strings.TrimSpace(c.RoomFromURL) == "standup", "room name resolved from default/URL")
		errs := pageErrors()
		assert(len(errs) == 0, "no uncaught page errors"+func() string {
			if len(errs) == 0 {
				return ""
			}
			return ": " + strings.Join(errs, " | ")
		}())

		png, err := p.Screenshot(ctx)
		if err == nil {
			err = os.WriteFile(*shot, png, 0o644)
		}
		if err != nil {
			return err
		}
		fmt.Println("screenshot: " + *shot)
		return nil
	}()
	if err != nil {
		fmt.Fprintln(os.Stderr, "conference smoke error:", err)
		return 1
	}
	if failed {
		fmt.Println("RESULT: FAIL")
		return 1
	}
	fmt.Println("RESULT: PASS")
	return 0
}
