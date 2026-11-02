package playback

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/security"
)

// The play-auth webhook (AntMedia's webhookPlayAuthUrl): before an anonymous
// playback grant (public play-token / listen-token, the HLS token) the core
// POSTs the request to features.play_auth.webhook_url and only grants on a
// 2xx. Errors, timeouts and non-2xx deny, unless fail_open. The body is
// signed like the app callbacks (X-StreamHub-Signature: sha256=<hex HMAC of
// the raw body under callbacks.secret>) when the app has a callback secret.
// The URL is tenant-controlled: the egress SSRF guard runs on every call and
// redirects are not followed.

// PlayAuthEvent is the X-StreamHub-Event of the webhook.
const PlayAuthEvent = "play.authorize"

// PlayAuthRequest is the webhook body.
type PlayAuthRequest struct {
	Event     string `json:"event"`
	App       string `json:"app"`
	Room      string `json:"room"`
	Mode      string `json:"mode"` // viewer | listener | hls
	IP        string `json:"ip"`
	Country   string `json:"country,omitempty"`
	UserAgent string `json:"userAgent"`
	Referer   string `json:"referer"`
	// Token is the viewer's own ?token= (a credential of the customer's
	// system, opaque to StreamHub), "" when absent.
	Token string `json:"token"`
	Ts    string `json:"ts"`
}

// errPlayAuthDenied is a non-2xx answer.
var errPlayAuthDenied = errors.New("denied by the play-auth webhook")

// callPlayAuth posts the request and reports whether the webhook granted it.
func (g *Guard) callPlayAuth(ctx context.Context, pa *contracts.PlayAuthFeatures, secret string, req PlayAuthRequest) error {
	if err := security.AssertSafeEgressURL(ctx, pa.WebhookURL, security.EgressOptions{
		AllowedSchemes: security.HTTPSchemes,
		Label:          "play-auth webhook URL",
		Allowlist:      security.ParseAllowlistEnv(os.Getenv(security.CallbackAllowHostsEnv)),
		Resolve:        g.resolve,
	}); err != nil {
		return err
	}
	body, err := json.Marshal(req)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(pa.TimeoutMs)*time.Millisecond)
	defer cancel()
	hr, err := http.NewRequestWithContext(ctx, http.MethodPost, pa.WebhookURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	hr.Header.Set("Content-Type", "application/json")
	hr.Header.Set("User-Agent", "streamhub-core/play-auth")
	hr.Header.Set("X-StreamHub-Event", PlayAuthEvent)
	hr.Header.Set("X-StreamHub-Timestamp", req.Ts)
	if secret != "" {
		m := hmac.New(sha256.New, []byte(secret))
		m.Write(body)
		hr.Header.Set("X-StreamHub-Signature", "sha256="+hex.EncodeToString(m.Sum(nil)))
	}
	res, err := g.client.Do(hr)
	if err != nil {
		return err
	}
	_ = res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return errPlayAuthDenied
	}
	return nil
}

// noRedirectClient never follows a redirect (a 3xx is a deny): a redirect
// would dodge the SSRF guard that vetted the configured URL.
func noRedirectClient() *http.Client {
	return &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
