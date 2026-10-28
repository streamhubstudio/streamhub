package samples

import (
	"fmt"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of example-bundle.ts: self-contained, statically-hostable example
// bundles (index.html + config.js + README.md) built from the same template
// source as the served /samples pages.

// ExampleContext is the runtime config a bundle is pre-filled with.
type ExampleContext struct {
	App     string
	Room    string
	BaseURL string
	WsURL   string
	// AdaptorURL overrides ${baseUrl}/sdk/streamhub-adaptor.global.js.
	AdaptorURL string
}

// ExampleDescriptor is one catalogue entry.
type ExampleDescriptor struct {
	ID             string   `json:"id"`
	File           string   `json:"file"`
	Title          string   `json:"title"`
	Description    string   `json:"description"`
	AuthModel      string   `json:"authModel"` // public | ephemeral | publisher
	RequiredConfig []string `json:"requiredConfig"`
	OptionalConfig []string `json:"optionalConfig"`
}

var coreKeys = []string{"baseUrl", "wsUrl", "app", "room"}

func credentialKeys(model string) []string {
	switch model {
	case "ephemeral":
		return []string{"token"}
	case "publisher":
		return []string{"token", "apiToken"}
	}
	return nil
}

// ExampleBundles is EXAMPLE_BUNDLES (order matches SampleFiles).
var ExampleBundles = []ExampleDescriptor{
	{"webrtc-publish", "webrtc-publish.html", "WebRTC publish", "Publish camera/mic to a room over WebRTC (low latency).", "publisher", coreKeys, []string{"token", "apiToken", "adaptorUrl"}},
	{"webrtc-play", "webrtc-play.html", "WebRTC play", "Subscribe/play a live room over WebRTC (low latency).", "public", coreKeys, []string{"adaptorUrl"}},
	{"hls-player", "hls-player.html", "HLS player", "video.js HLS player for a room (higher latency, CDN-friendly).", "public", coreKeys, []string{}},
	{"audio-radio", "audio-radio.html", "Radio (master + listener)", "Audio radio: master goes on air with the mic; listeners tune in.", "publisher", coreKeys, []string{"token", "apiToken", "adaptorUrl"}},
	{"cctv-grid", "cctv-grid.html", "CCTV grid", "Low-latency grid of N live cameras (comma-separated rooms).", "public", coreKeys, []string{"adaptorUrl"}},
	{"live-shopping", "live-shopping.html", "Live shopping", "WebRTC viewer + chat/reactions data channel + buy button.", "public", coreKeys, []string{"token", "adaptorUrl"}},
	{"telemedicine", "telemedicine.html", "Telemedicine 1:1", "Private 1:1 room joined with a pre-minted ephemeral token.", "ephemeral", coreKeys, []string{"token", "adaptorUrl"}},
	{"radio-player", "radio-player.html", "Radio player", "Embeddable audio-only listener on the public listen token.", "public", coreKeys, []string{"adaptorUrl"}},
	{"conference", "conference.html", "Conference (N-to-N)", "Google-Meet-style meeting: pre-join, tiles, screen share, chat.", "publisher", coreKeys, []string{"token", "apiToken", "adaptorUrl"}},
}

// PlaceholderContext is PLACEHOLDER_CONTEXT (no real host/tenant). Compared
// by identity in BuildReadme, as Node does.
var PlaceholderContext = &ExampleContext{
	App: "YOUR_APP", Room: "demo",
	BaseURL: "https://your-streamhub.example.com", WsURL: "wss://your-streamhub.example.com",
}

// GetExample finds a catalogue entry by id.
func GetExample(id string) *ExampleDescriptor {
	for i := range ExampleBundles {
		if ExampleBundles[i].ID == id {
			return &ExampleBundles[i]
		}
	}
	return nil
}

func placeholderMap(ctx *ExampleContext) map[string]string {
	base := strings.TrimRight(ctx.BaseURL, "/")
	adaptor := ctx.AdaptorURL
	if adaptor == "" {
		adaptor = base + "/sdk/streamhub-adaptor.global.js"
	}
	return map[string]string{
		"APP": ctx.App, "ROOM": ctx.Room, "WS_URL": ctx.WsURL,
		"API_URL": base + "/api/v1", "ADAPTOR_URL": adaptor, "HLS_URL": base + "/hls/" + ctx.App,
	}
}

// ConfigScriptTag is injected before the first <script of index.html.
const ConfigScriptTag = `<script src="./config.js"></script>`

func toStandaloneHTML(rendered string) string {
	idx := strings.Index(rendered, "<script")
	if idx == -1 {
		return rendered + "\n" + ConfigScriptTag + "\n"
	}
	return rendered[:idx] + ConfigScriptTag + "\n" + rendered[idx:]
}

// j is JSON.stringify(string).
func j(v string) string {
	s, _ := yamljs.Stringify(v)
	return s
}

// BuildConfigJs builds config.js (the only file a user edits).
func BuildConfigJs(d *ExampleDescriptor, ctx *ExampleContext) string {
	creds := credentialKeys(d.AuthModel)
	has := func(k string) bool {
		for _, c := range creds {
			if c == k {
				return true
			}
		}
		return false
	}
	lines := []string{
		"// StreamHub example configuration — EDIT THIS FILE.",
		"//",
		fmt.Sprintf("// Example: %s — %s", d.Title, d.Description),
		"//",
		"// Point this bundle at YOUR StreamHub. Nothing else needs to",
		"// change: host this folder on any static host (S3, Netlify, nginx,",
		"// GitHub Pages) and open index.html.",
		"window.STREAMHUB_CONFIG = {",
		"  // StreamHub public origin (REST + HLS + SDK). No trailing slash.",
		"  baseUrl: " + j(ctx.BaseURL) + ",",
		"  // LiveKit signaling WebSocket URL (wss://…).",
		"  wsUrl: " + j(ctx.WsURL) + ",",
		"  // Your app slug.",
		"  app: " + j(ctx.App) + ",",
		"  // Default room name.",
		"  room: " + j(ctx.Room) + ",",
	}
	if has("token") {
		lines = append(lines, "",
			"  // Ephemeral LiveKit JWT for publishing/joining. Mint it",
			"  // server-side and paste it here, OR pass it in the URL hash",
			"  // (#token=…). Leave empty for subscribe-only usage.",
			"  token: '',")
	}
	if has("apiToken") {
		lines = append(lines, "",
			"  // DEV ONLY: an sk_ management token to mint LiveKit tokens on",
			"  // the fly. Never ship this to end users — prefer `token` above.",
			"  apiToken: '',")
	}
	lines = append(lines, "",
		"  // Optional: override the adaptor SDK URL (defaults to",
		`  // baseUrl + "/sdk/streamhub-adaptor.global.js").`,
		"  // adaptorUrl: '',",
		"};",
		"")
	return strings.Join(lines, "\n")
}

var authNote = map[string]string{
	"public": "This example is **subscribe-only** and uses the PUBLIC play/listen token — " +
		"no credential needed, as long as the app has public playback enabled.",
	"ephemeral": "This example joins a private room with a **pre-minted ephemeral LiveKit " +
		"JWT**. Mint one server-side (per participant) and either paste it into " +
		"`config.js` (`token`) or share a link with `#token=…&room=…&ws=…`.",
	"publisher": "This example **publishes** media. Supply an ephemeral LiveKit JWT " +
		"(`config.js` `token`, or `#token=…` in the URL). For local dev you may " +
		"instead set `apiToken` to an `sk_` management token to mint on the fly — " +
		"never expose that token to end users.",
}

// bt turns the § marks of a JS template literal transcription into backticks.
func bt(s string) string { return strings.ReplaceAll(s, "§", "`") }

var readmeTmpl = bt(`# StreamHub example — %[1]s

%[2]s

## Run it

1. Edit **§config.js§** and set §baseUrl§, §wsUrl§, §app§ and §room§ to your
   StreamHub instance.%[3]s
2. Host this folder on **any static host** — S3, Netlify, nginx, GitHub Pages —
   or just open §index.html§ locally.
3. Done. No build step.

## Files

| File | Purpose |
|------|---------|
| §index.html§ | The example (identical to the page served at §/samples/%[4]s/%[5]s§). |
| §config.js§ | The knobs you edit. Sets §window.STREAMHUB_CONFIG§. |

## Authentication

%[6]s

## Notes

- §index.html§ loads the **livekit-client** from a pinned CDN
  (§livekit-client@2.15.7§) and the optional **streamhub-adaptor** from your own
  StreamHub (§baseUrl + /sdk/…§); it falls back to livekit-client if the adaptor
  is not deployed. You may self-host either — see §adaptorUrl§ in §config.js§.
- **CORS:** the browser fetches the play/listen token from §baseUrl/api/v1/…§.
  A remote static host is a *different origin*, so your StreamHub must allow
  cross-origin reads on the public token endpoints (StreamHub sends
  §Access-Control-Allow-Origin: *§ on §play-token§/§listen-token§). Same-origin
  hosting (serving the bundle from the StreamHub domain) needs no CORS.
`)

// BuildReadme builds the per-bundle README.md.
func BuildReadme(d *ExampleDescriptor, ctx *ExampleContext) string {
	remote := ""
	if ctx == PlaceholderContext || strings.Contains(ctx.BaseURL, "example.com") {
		remote = " (They currently hold placeholders.)"
	}
	return fmt.Sprintf(readmeTmpl, d.Title, d.Description, remote, ctx.App, d.File, authNote[d.AuthModel])
}

// BundleFile is one file of a bundle (ordered: index.html, config.js, README.md).
type BundleFile struct {
	Name string
	Data string
}

// BuildExampleBundle builds the standalone bundle for one example id; nil
// ctx means PlaceholderContext.
func BuildExampleBundle(id string, ctx *ExampleContext) (*ExampleDescriptor, []BundleFile, error) {
	if ctx == nil {
		ctx = PlaceholderContext
	}
	d := GetExample(id)
	if d == nil {
		return nil, nil, fmt.Errorf(`unknown example "%s"`, id)
	}
	rendered := RenderPlaceholders(Templates[d.File], placeholderMap(ctx))
	return d, []BundleFile{
		{"index.html", toStandaloneHTML(rendered)},
		{"config.js", BuildConfigJs(d, ctx)},
		{"README.md", BuildReadme(d, ctx)},
	}, nil
}

// NamedBundle is one entry of BuildAllBundles (catalogue order).
type NamedBundle struct {
	ID    string
	Files []BundleFile
}

// BuildAllBundles builds every example bundle, in catalogue order.
func BuildAllBundles(ctx *ExampleContext) []NamedBundle {
	out := make([]NamedBundle, 0, len(ExampleBundles))
	for _, d := range ExampleBundles {
		_, files, _ := BuildExampleBundle(d.ID, ctx)
		out = append(out, NamedBundle{d.ID, files})
	}
	return out
}
