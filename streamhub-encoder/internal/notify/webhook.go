package notify

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Webhook request headers.
const (
	HeaderEvent     = "X-Encoder-Event"     // the event type
	HeaderSignature = "X-Encoder-Signature" // "sha256=" + hex(HMAC-SHA256(secret, body))
	userAgent       = "streamhub-encoder"
)

type webhookTarget struct {
	cfg   Webhook
	types map[string]bool // nil = all
	label string          // log/error label, URL without query/userinfo
	err   error           // config error, reported on every delivery
}

func newWebhookTarget(w Webhook) *webhookTarget {
	t := &webhookTarget{cfg: w, label: "webhook " + redactURL(w.URL)}
	if len(w.Types) > 0 {
		t.types = make(map[string]bool, len(w.Types))
		for _, ty := range w.Types {
			t.types[ty] = true
		}
	}
	u, err := url.Parse(w.URL)
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err // url.Error repeats the whole URL (userinfo and query included)
	}
	switch {
	case err != nil:
		t.err = fmt.Errorf("%w: url: %v", errConfig, err)
	case u.Scheme != "http" && u.Scheme != "https":
		t.err = fmt.Errorf("%w: url scheme must be http or https", errConfig)
	case u.Host == "":
		t.err = fmt.Errorf("%w: url has no host", errConfig)
	}
	return t
}

// wants reports whether the webhook subscribes to events of type ty.
func (t *webhookTarget) wants(ty string) bool {
	return t.types == nil || t.types[ty]
}

// redactURL keeps scheme, host and path so credentials or tokens carried in
// the userinfo or query string never reach logs, errors or Stats.
func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "(invalid url)"
	}
	return u.Scheme + "://" + u.Host + u.Path
}

// Sign returns the X-Encoder-Signature value for body: "sha256=" followed by
// the hex HMAC-SHA256 of body keyed with secret. Receivers recompute it over
// the raw request body and compare in constant time.
func Sign(secret string, body []byte) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write(body)
	return "sha256=" + hex.EncodeToString(m.Sum(nil))
}

// statusError is a non-2xx webhook response.
type statusError struct{ code int }

func (e *statusError) Error() string { return fmt.Sprintf("http status %d", e.code) }

// sendWebhook POSTs e to t. With retry, network errors and 5xx responses are
// retried after each of n.opts.backoff (1 s, 3 s, 9 s by default); 3xx/4xx
// are final. ctx cancellation aborts both the request and the back-off.
func (n *Notifier) sendWebhook(ctx context.Context, t *webhookTarget, e Event, retry bool) error {
	if t.err != nil {
		return t.err
	}
	body, err := json.Marshal(e)
	if err != nil {
		return fmt.Errorf("encode event: %w", err)
	}
	for attempt := 0; ; attempt++ {
		err = n.postOnce(ctx, t, e.Type, body)
		if err == nil {
			return nil
		}
		if !retry || attempt >= len(n.opts.backoff) || !retryable(ctx, err) {
			if attempt > 0 {
				return fmt.Errorf("%w (after %d attempts)", err, attempt+1)
			}
			return err
		}
		n.log.Debug("webhook attempt failed, retrying", "target", t.label, "attempt", attempt+1, "err", err)
		timer := time.NewTimer(n.opts.backoff[attempt])
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return fmt.Errorf("%w (retry aborted: %v)", err, ctx.Err())
		}
	}
}

// retryable: 5xx and transport errors, unless the caller's ctx is done.
func retryable(ctx context.Context, err error) bool {
	if ctx.Err() != nil {
		return false
	}
	var se *statusError
	if errors.As(err, &se) {
		return se.code >= 500
	}
	return true
}

// postOnce makes a single POST attempt bounded by webhookTimeout.
func (n *Notifier) postOnce(ctx context.Context, t *webhookTarget, typ string, body []byte) error {
	ctx, cancel := context.WithTimeout(ctx, webhookTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.cfg.URL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("%w: %v", errConfig, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set(HeaderEvent, typ)
	if t.cfg.Secret != "" {
		req.Header.Set(HeaderSignature, Sign(t.cfg.Secret, body))
	}
	resp, err := n.client.Do(req)
	if err != nil {
		// url.Error repeats the full URL (query included); keep only the cause.
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return err
	}
	// Drain a bounded amount so the keep-alive connection can be reused.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return &statusError{code: resp.StatusCode}
	}
	return nil
}
