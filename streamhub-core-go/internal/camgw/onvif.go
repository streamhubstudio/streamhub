package camgw

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Onvif is the small ONVIF client the gateway needs: PTZ over the profile of
// the main stream (ContinuousMove/Stop, home, presets, status), with
// WS-Security UsernameToken digest auth.
type Onvif struct {
	cfg  ONVIF
	http *http.Client

	mu      sync.Mutex
	ptzURL  string
	profile string
}

func NewOnvif(cfg ONVIF) *Onvif {
	return &Onvif{cfg: cfg, http: &http.Client{Timeout: 8 * time.Second}}
}

const (
	nsDevice = "http://www.onvif.org/ver10/device/wsdl"
	nsMedia  = "http://www.onvif.org/ver10/media/wsdl"
	nsPTZ    = "http://www.onvif.org/ver20/ptz/wsdl"
	nsSchema = "http://www.onvif.org/ver10/schema"
)

func (o *Onvif) envelope(body string) []byte {
	var hdr string
	if o.cfg.User != "" {
		nonce := make([]byte, 16)
		_, _ = rand.Read(nonce)
		created := time.Now().UTC().Format("2006-01-02T15:04:05Z")
		h := sha1.New()
		h.Write(nonce)
		h.Write([]byte(created))
		h.Write([]byte(o.cfg.Pass))
		hdr = `<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">` +
			`<UsernameToken><Username>` + html.EscapeString(o.cfg.User) + `</Username>` +
			`<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">` +
			base64.StdEncoding.EncodeToString(h.Sum(nil)) + `</Password>` +
			`<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">` +
			base64.StdEncoding.EncodeToString(nonce) + `</Nonce>` +
			`<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">` + created + `</Created>` +
			`</UsernameToken></Security></s:Header>`
	}
	return []byte(`<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">` +
		hdr + `<s:Body>` + body + `</s:Body></s:Envelope>`)
}

func (o *Onvif) call(ctx context.Context, url, body string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(o.envelope(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/soap+xml; charset=utf-8")
	res, err := o.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		if m := faultRe.FindSubmatch(b); m != nil {
			return nil, fmt.Errorf("onvif %d: %s", res.StatusCode, strings.TrimSpace(string(m[1])))
		}
		return nil, fmt.Errorf("onvif http %d", res.StatusCode)
	}
	return b, nil
}

var (
	faultRe   = regexp.MustCompile(`(?s)<[a-zA-Z0-9]*:?Text[^>]*>(.*?)</`)
	ptzAddrRe = regexp.MustCompile(`(?s)<[a-zA-Z0-9]*:?PTZ>\s*<[a-zA-Z0-9]*:?XAddr>([^<]+)<`)
	medAddrRe = regexp.MustCompile(`(?s)<[a-zA-Z0-9]*:?Media>\s*<[a-zA-Z0-9]*:?XAddr>([^<]+)<`)
	profileRe = regexp.MustCompile(`<[a-zA-Z0-9]*:?Profiles[^>]*token="([^"]+)"`)
	presetRe  = regexp.MustCompile(`(?s)<[a-zA-Z0-9]*:?Preset[^>]*token="([^"]+)"[^>]*>(.*?)</[a-zA-Z0-9]*:?Preset>`)
	nameRe    = regexp.MustCompile(`<[a-zA-Z0-9]*:?Name>([^<]*)<`)
	panTiltRe = regexp.MustCompile(`<[a-zA-Z0-9]*:?PanTilt[^>]*x="([^"]+)"[^>]*y="([^"]+)"`)
	moveRe    = regexp.MustCompile(`<[a-zA-Z0-9]*:?PanTilt>\s*([A-Z]+)\s*<`)
)

// init discovers the PTZ and media services and the first profile.
func (o *Onvif) init(ctx context.Context) (ptz, profile string, err error) {
	o.mu.Lock()
	if o.ptzURL != "" {
		defer o.mu.Unlock()
		return o.ptzURL, o.profile, nil
	}
	o.mu.Unlock()
	b, err := o.call(ctx, o.cfg.URL, `<GetCapabilities xmlns="`+nsDevice+`"><Category>All</Category></GetCapabilities>`)
	if err != nil {
		return "", "", err
	}
	pm, mm := ptzAddrRe.FindSubmatch(b), medAddrRe.FindSubmatch(b)
	if pm == nil || mm == nil {
		return "", "", errors.New("camera has no ONVIF PTZ service")
	}
	b, err = o.call(ctx, string(mm[1]), `<GetProfiles xmlns="`+nsMedia+`"/>`)
	if err != nil {
		return "", "", err
	}
	prof := profileRe.FindSubmatch(b)
	if prof == nil {
		return "", "", errors.New("camera has no media profile")
	}
	o.mu.Lock()
	o.ptzURL, o.profile = strings.TrimSpace(string(pm[1])), string(prof[1])
	o.mu.Unlock()
	return o.ptzURL, o.profile, nil
}

// Probe reports whether PTZ works (used to advertise the "ptz" cap).
func (o *Onvif) Probe(ctx context.Context) error {
	_, _, err := o.init(ctx)
	return err
}

func (o *Onvif) ptz(ctx context.Context, body func(profile string) string) ([]byte, error) {
	url, prof, err := o.init(ctx)
	if err != nil {
		return nil, err
	}
	return o.call(ctx, url, body(html.EscapeString(prof)))
}

// Move starts a continuous pan/tilt (x, y in -1..1).
func (o *Onvif) Move(ctx context.Context, x, y float64) error {
	_, err := o.ptz(ctx, func(p string) string {
		return fmt.Sprintf(`<ContinuousMove xmlns="%s"><ProfileToken>%s</ProfileToken><Velocity><PanTilt xmlns="%s" x="%.2f" y="%.2f"/></Velocity></ContinuousMove>`, nsPTZ, p, nsSchema, x, y)
	})
	return err
}

func (o *Onvif) Stop(ctx context.Context) error {
	_, err := o.ptz(ctx, func(p string) string {
		return `<Stop xmlns="` + nsPTZ + `"><ProfileToken>` + p + `</ProfileToken><PanTilt>true</PanTilt><Zoom>true</Zoom></Stop>`
	})
	return err
}

func (o *Onvif) Home(ctx context.Context) error {
	_, err := o.ptz(ctx, func(p string) string {
		return `<GotoHomePosition xmlns="` + nsPTZ + `"><ProfileToken>` + p + `</ProfileToken></GotoHomePosition>`
	})
	return err
}

// Preset is an ONVIF preset (token + name).
type Preset struct {
	Token string `json:"id"`
	Name  string `json:"name"`
}

func (o *Onvif) Presets(ctx context.Context) ([]Preset, error) {
	b, err := o.ptz(ctx, func(p string) string {
		return `<GetPresets xmlns="` + nsPTZ + `"><ProfileToken>` + p + `</ProfileToken></GetPresets>`
	})
	if err != nil {
		return nil, err
	}
	out := []Preset{}
	for _, m := range presetRe.FindAllSubmatch(b, -1) {
		name := ""
		if n := nameRe.FindSubmatch(m[2]); n != nil {
			name = html.UnescapeString(string(n[1]))
		}
		out = append(out, Preset{Token: string(m[1]), Name: name})
	}
	return out, nil
}

func (o *Onvif) GotoPreset(ctx context.Context, token string) error {
	_, err := o.ptz(ctx, func(p string) string {
		return `<GotoPreset xmlns="` + nsPTZ + `"><ProfileToken>` + p + `</ProfileToken><PresetToken>` + html.EscapeString(token) + `</PresetToken></GotoPreset>`
	})
	return err
}

func (o *Onvif) SavePreset(ctx context.Context, name string) (string, error) {
	b, err := o.ptz(ctx, func(p string) string {
		return `<SetPreset xmlns="` + nsPTZ + `"><ProfileToken>` + p + `</ProfileToken><PresetName>` + html.EscapeString(name) + `</PresetName></SetPreset>`
	})
	if err != nil {
		return "", err
	}
	var r struct {
		Token string `xml:"Body>SetPresetResponse>PresetToken"`
	}
	_ = xml.Unmarshal(b, &r)
	return r.Token, nil
}

func (o *Onvif) RemovePreset(ctx context.Context, token string) error {
	_, err := o.ptz(ctx, func(p string) string {
		return `<RemovePreset xmlns="` + nsPTZ + `"><ProfileToken>` + p + `</ProfileToken><PresetToken>` + html.EscapeString(token) + `</PresetToken></RemovePreset>`
	})
	return err
}

// Status is the pan/tilt position (-1..1) and whether it is moving.
func (o *Onvif) Status(ctx context.Context) (x, y float64, moving bool, err error) {
	b, err := o.ptz(ctx, func(p string) string {
		return `<GetStatus xmlns="` + nsPTZ + `"><ProfileToken>` + p + `</ProfileToken></GetStatus>`
	})
	if err != nil {
		return 0, 0, false, err
	}
	if m := panTiltRe.FindSubmatch(b); m != nil {
		fmt.Sscanf(string(m[1]), "%g", &x)
		fmt.Sscanf(string(m[2]), "%g", &y)
	}
	if m := moveRe.FindSubmatch(b); m != nil {
		moving = string(m[1]) == "MOVING"
	}
	return x, y, moving, nil
}
