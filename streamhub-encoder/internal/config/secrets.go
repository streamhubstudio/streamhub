package config

import (
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/notify"
)

// Secrets policy: no secret leaves the box through the API, the UI, the
// process logs/commands the API shows, alarms, webhooks or metrics. They are
// write-only: reads carry the Redacted placeholder ("***") in their place, and
// a write that sends the placeholder back keeps the stored value — but only
// while the destination is unchanged (a placeholder never follows a secret to
// a new host). A placeholder with no stored value behind it is a validation
// error ("re-enter"), never a literal secret.
//
// Secrets: SRT passphrases (outputs, and the passphrase query of SRT input
// URIs), any URL's userinfo password, sensitive query parameters (token,
// passphrase, key, …), the stream key (last path segment) of rtmp/rtmps URLs,
// WHIP bearer tokens, the StreamHub app token / resolved stream key / device
// credential, webhook HMAC secrets and SNMP communities and v3 passphrases.

// sensitiveQuery are query parameter names whose value is a secret.
var sensitiveQuery = map[string]bool{
	"passphrase": true, "password": true, "passwd": true, "pass": true, "pwd": true, "secret": true,
	"token": true, "access_token": true, "auth": true, "authorization": true, "jwt": true, "sig": true, "signature": true,
	"key": true, "apikey": true, "api_key": true, "streamkey": true, "stream_key": true, "credential": true, "credentials": true,
}

// urlParts is a URL split without any re-encoding, so format(parse(s)) == s.
type urlParts struct {
	scheme, user, pass, host, path, frag string
	hasAt, hasPass, hasQuery             bool
	query                                []queryPair
}

type queryPair struct {
	k, v  string
	hasEq bool
}

func parseURL(raw string) (urlParts, bool) {
	i := strings.Index(raw, "://")
	if i <= 0 {
		return urlParts{}, false
	}
	p := urlParts{scheme: strings.ToLower(raw[:i])}
	rest := raw[i+3:]
	if j := strings.IndexByte(rest, '#'); j >= 0 {
		p.frag, rest = rest[j:], rest[:j]
	}
	if j := strings.IndexByte(rest, '?'); j >= 0 {
		p.hasQuery = true
		for _, kv := range strings.Split(rest[j+1:], "&") {
			k, v, eq := strings.Cut(kv, "=")
			p.query = append(p.query, queryPair{k: k, v: v, hasEq: eq})
		}
		rest = rest[:j]
	}
	p.host = rest
	if j := strings.IndexByte(rest, '/'); j >= 0 {
		p.host, p.path = rest[:j], rest[j:]
	}
	if at := strings.LastIndexByte(p.host, '@'); at >= 0 {
		p.hasAt = true
		ui := p.host[:at]
		p.host = p.host[at+1:]
		p.user, p.pass, p.hasPass = strings.Cut(ui, ":")
	}
	return p, true
}

func (p urlParts) String() string {
	var b strings.Builder
	b.WriteString(p.scheme + "://")
	if p.hasAt {
		b.WriteString(p.user)
		if p.hasPass {
			b.WriteString(":" + p.pass)
		}
		b.WriteByte('@')
	}
	b.WriteString(p.host + p.path)
	if p.hasQuery {
		b.WriteByte('?')
		for i, q := range p.query {
			if i > 0 {
				b.WriteByte('&')
			}
			b.WriteString(q.k)
			if q.hasEq {
				b.WriteString("=" + q.v)
			}
		}
	}
	b.WriteString(p.frag)
	return b.String()
}

func isSensitiveKey(k string) bool {
	if u, err := url.QueryUnescape(k); err == nil {
		k = u
	}
	return sensitiveQuery[strings.ToLower(k)]
}

// streamKey returns the index in p.path where the rtmp stream key starts
// (rtmp[s]://host/app/<key>), or -1.
func (p urlParts) streamKey() int {
	if p.scheme != "rtmp" && p.scheme != "rtmps" {
		return -1
	}
	trimmed := strings.Trim(p.path, "/")
	if !strings.Contains(trimmed, "/") || strings.HasSuffix(p.path, "/") {
		return -1
	}
	return strings.LastIndexByte(p.path, '/') + 1
}

// redact masks p in place and returns the secret values it masked.
func (p *urlParts) redact() []string {
	var sec []string
	if p.hasPass && p.pass != "" {
		sec = append(sec, p.pass)
		p.pass = Redacted
	}
	for i := range p.query {
		if q := &p.query[i]; q.hasEq && q.v != "" && isSensitiveKey(q.k) {
			sec = append(sec, q.v)
			q.v = Redacted
		}
	}
	if k := p.streamKey(); k >= 0 {
		sec = append(sec, p.path[k:])
		p.path = p.path[:k] + Redacted
	}
	var out []string
	for _, s := range sec {
		if s != Redacted {
			out = append(out, s)
			if u, err := url.QueryUnescape(s); err == nil && u != s {
				out = append(out, u)
			}
		}
	}
	return out
}

// RedactURL masks the secrets a URL carries (userinfo password, sensitive
// query values, rtmp stream key). Anything else is returned byte for byte.
func RedactURL(raw string) string {
	p, ok := parseURL(raw)
	if !ok {
		return raw
	}
	if len(p.redact()) == 0 {
		return raw
	}
	return p.String()
}

// URLSecrets returns the secret values carried by a URL.
func URLSecrets(raw string) []string {
	p, ok := parseURL(raw)
	if !ok {
		return nil
	}
	return p.redact()
}

// keepURL restores next from prev when next is exactly prev's redacted form
// (the destination is unchanged); anything else is an explicit new value.
func keepURL(prev, next string) string {
	if next != prev && strings.Contains(next, Redacted) && RedactURL(prev) == next {
		return prev
	}
	return next
}

func redactStr(s string) string {
	if s == "" {
		return s
	}
	return Redacted
}

// OutputSecrets returns the secret values of one output.
func OutputSecrets(o Output) []string {
	sec := URLSecrets(o.URL)
	if o.SRT != nil && o.SRT.Passphrase != "" {
		sec = append(sec, o.SRT.Passphrase, url.QueryEscape(o.SRT.Passphrase))
	}
	if o.WHIP != nil && o.WHIP.BearerToken != "" {
		sec = append(sec, o.WHIP.BearerToken)
	}
	if s := o.StreamHub; s != nil {
		sec = append(sec, s.Token, s.StreamKey)
		sec = append(sec, URLSecrets(s.ResolvedURL)...)
		sec = append(sec, URLSecrets(s.BaseURL)...)
	}
	return sec
}

// ChannelSecrets returns every secret value a channel holds (inputs and
// outputs), for scrubbing free text such as command lines and logs.
func ChannelSecrets(ch Channel) []string {
	sec := URLSecrets(ch.Input.URI)
	if ch.Backup != nil {
		sec = append(sec, URLSecrets(ch.Backup.URI)...)
	}
	for _, o := range ch.Outputs {
		sec = append(sec, OutputSecrets(o)...)
	}
	return sec
}

var (
	reURLText  = regexp.MustCompile(`[A-Za-z][A-Za-z0-9+.-]*://[^\s"'<>]*[^\s"'<>.,;:)\]}]`) // no trailing punctuation
	reKVSecret = regexp.MustCompile(`(?i)\b(passphrase|password|passwd|token|secret|bearer)=("[^"]*"|[^\s"&]+)`)
)

// minScrubLen: shorter values are only masked structurally (inside URLs or
// key=value pairs) so a 2-letter key does not shred unrelated text.
const minScrubLen = 4

// Scrub masks secrets in free text (command lines, process logs, error
// messages): every known secret value, the secrets of any URL in the text and
// the value of passphrase=/password=/token=/secret= pairs (gst properties).
func Scrub(text string, secrets []string) string {
	if text == "" {
		return text
	}
	vals := make([]string, 0, len(secrets))
	for _, s := range secrets {
		if len(s) >= minScrubLen && s != Redacted {
			vals = append(vals, s)
		}
	}
	sort.Slice(vals, func(i, j int) bool { return len(vals[i]) > len(vals[j]) })
	for _, s := range vals {
		text = strings.ReplaceAll(text, s, Redacted)
	}
	text = reURLText.ReplaceAllStringFunc(text, RedactURL)
	return reKVSecret.ReplaceAllStringFunc(text, func(m string) string {
		k, v, _ := strings.Cut(m, "=")
		if strings.HasPrefix(v, `"`) {
			return k + `="` + Redacted + `"`
		}
		return k + "=" + Redacted
	})
}

// ScrubAll scrubs every string of a slice (returns a new slice).
func ScrubAll(lines, secrets []string) []string {
	if lines == nil {
		return nil
	}
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = Scrub(l, secrets)
	}
	return out
}

// Redact returns a copy with every secret replaced by Redacted: channels,
// the StreamHub device credential and the notification targets.
func Redact(c Config) Config {
	c = clone(c)
	c.StreamHub.Credential = redactStr(c.StreamHub.Credential)
	for i := range c.Channels {
		RedactChannel(&c.Channels[i])
	}
	if c.Settings.Notify != nil {
		n := NotifyConfig(RedactNotify(notify.Config(*c.Settings.Notify)))
		c.Settings.Notify = &n
	}
	return c
}

// RedactChannel redacts one channel in place (pointer fields are copied, so
// a channel sharing them with the store is never modified).
func RedactChannel(ch *Channel) {
	ch.Input.URI = RedactURL(ch.Input.URI)
	if ch.Backup != nil {
		b := *ch.Backup
		b.URI = RedactURL(b.URI)
		ch.Backup = &b
	}
	outs := make([]Output, len(ch.Outputs))
	for j, o := range ch.Outputs {
		o.URL = RedactURL(o.URL)
		if o.SRT != nil {
			s := *o.SRT
			s.Passphrase = redactStr(s.Passphrase)
			o.SRT = &s
		}
		if o.WHIP != nil {
			w := *o.WHIP
			w.BearerToken = redactStr(w.BearerToken)
			o.WHIP = &w
		}
		if o.StreamHub != nil {
			s := *o.StreamHub
			s.Token, s.StreamKey = redactStr(s.Token), redactStr(s.StreamKey)
			s.ResolvedURL, s.BaseURL = RedactURL(s.ResolvedURL), RedactURL(s.BaseURL)
			o.StreamHub = &s
		}
		outs[j] = o
	}
	if ch.Outputs != nil {
		ch.Outputs = outs
	}
}

// KeepSecrets copies secrets from prev into next wherever next carries the
// Redacted placeholder and the destination is unchanged (so a GET→edit→PUT
// round trip never loses a secret, and a placeholder never follows a secret
// to another host). Placeholders that cannot be restored stay and fail
// validation, except the encoder-resolved StreamHub ingress, which is reset.
func KeepSecrets(prev, next *Channel) {
	next.Input.URI = keepURL(prev.Input.URI, next.Input.URI)
	if next.Backup != nil && prev.Backup != nil {
		next.Backup.URI = keepURL(prev.Backup.URI, next.Backup.URI)
	}
	for j := range next.Outputs {
		n := &next.Outputs[j]
		k := prev.FindOutput(n.ID)
		if k < 0 {
			resetResolution(n)
			continue
		}
		p := prev.Outputs[k]
		n.URL = keepURL(p.URL, n.URL)
		sameDest := n.URL == p.URL
		if n.SRT != nil && n.SRT.Passphrase == Redacted && sameDest && p.SRT != nil && p.SRT.Passphrase != "" {
			n.SRT.Passphrase = p.SRT.Passphrase
		}
		if n.WHIP != nil && n.WHIP.BearerToken == Redacted && sameDest && p.WHIP != nil && p.WHIP.BearerToken != "" {
			n.WHIP.BearerToken = p.WHIP.BearerToken
		}
		if s, ps := n.StreamHub, p.StreamHub; s != nil && ps != nil {
			s.BaseURL = keepURL(ps.BaseURL, s.BaseURL)
			if s.BaseURL == ps.BaseURL && s.App == ps.App {
				if s.Token == Redacted && ps.Token != "" {
					s.Token = ps.Token
				}
				if s.StreamKey == Redacted {
					s.StreamKey = ps.StreamKey
				}
				s.ResolvedURL = keepURL(ps.ResolvedURL, s.ResolvedURL)
			}
		}
		resetResolution(n)
	}
}

// resetResolution drops an encoder-resolved StreamHub ingress that still
// carries placeholders (it is re-resolved with the app token).
func resetResolution(o *Output) {
	if s := o.StreamHub; s != nil && (s.StreamKey == Redacted || strings.Contains(s.ResolvedURL, Redacted)) {
		s.IngressID, s.StreamKey, s.ResolvedURL = "", "", ""
	}
}

// RedactNotify returns a copy of the notification targets without secrets.
func RedactNotify(n notify.Config) notify.Config {
	out := notify.Config{Webhooks: make([]notify.Webhook, len(n.Webhooks)), SNMP: make([]notify.SNMPTarget, len(n.SNMP))}
	for i, w := range n.Webhooks {
		w.URL, w.Secret = RedactURL(w.URL), redactStr(w.Secret)
		w.Types = append([]string(nil), w.Types...)
		out.Webhooks[i] = w
	}
	for i, s := range n.SNMP {
		s.Community, s.AuthPass, s.PrivPass = redactStr(s.Community), redactStr(s.AuthPass), redactStr(s.PrivPass)
		out.SNMP[i] = s
	}
	return out
}

// KeepNotifySecrets restores placeholders in next from prev (nil = none):
// a webhook keeps its secret while its URL is unchanged, an SNMP target its
// community/passphrases while address, version and user are unchanged.
func KeepNotifySecrets(prev *NotifyConfig, next *NotifyConfig) {
	if next == nil || prev == nil {
		return
	}
	for i := range next.Webhooks {
		w := &next.Webhooks[i]
		for _, p := range prev.Webhooks {
			if u := keepURL(p.URL, w.URL); u == p.URL {
				w.URL = u
				if w.Secret == Redacted {
					w.Secret = p.Secret
				}
				break
			}
		}
	}
	for i := range next.SNMP {
		s := &next.SNMP[i]
		for _, p := range prev.SNMP {
			if p.Address == s.Address && p.Version == s.Version && p.User == s.User {
				if s.Community == Redacted {
					s.Community = p.Community
				}
				if s.AuthPass == Redacted {
					s.AuthPass = p.AuthPass
				}
				if s.PrivPass == Redacted {
					s.PrivPass = p.PrivPass
				}
				break
			}
		}
	}
}

const placeholderMsg = "is the " + Redacted + " placeholder and no stored secret matches (new id or changed destination): re-enter it"

func validateNotify(errs *Errors, n *NotifyConfig) {
	if n == nil {
		return
	}
	for i, w := range n.Webhooks {
		p := fmt.Sprintf("settings.notify.webhooks[%d]", i)
		if strings.Contains(w.URL, Redacted) {
			errs.add(p+".url", placeholderMsg)
		}
		if w.Secret == Redacted {
			errs.add(p+".secret", placeholderMsg)
		}
	}
	for i, s := range n.SNMP {
		for _, f := range []struct{ name, v string }{{"community", s.Community}, {"authPass", s.AuthPass}, {"privPass", s.PrivPass}} {
			if f.v == Redacted {
				errs.add(fmt.Sprintf("settings.notify.snmp[%d].%s", i, f.name), placeholderMsg)
			}
		}
	}
}
