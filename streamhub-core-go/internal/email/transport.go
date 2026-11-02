package email

import (
	"context"
	"crypto/tls"
	"net"
	"time"

	mail "github.com/wneessen/go-mail"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
)

// SMTPTransport is the real Transport over go-mail. Like nodemailer's
// createTransport({secure: port===465, requireTLS: !secure}) it uses implicit
// TLS on 465 and mandatory STARTTLS elsewhere, auto-discovering the AUTH
// mechanism.
type SMTPTransport struct {
	// Timeout bounds dial + each SMTP command (default 30s).
	Timeout time.Duration
}

// egressKey carries the dial guard of a tenant SMTP (per-app / per-user):
// that host is tenant input, so its dial goes through the SSRF guard — a
// private/loopback/link-local target is refused before connecting (the
// resolved IP is what gets checked, so DNS rebinding is covered too). The
// operator's global env SMTP carries none.
type egressKey struct{}

func withEgressGuard(ctx context.Context, g *httpx.EgressGuard) context.Context {
	return context.WithValue(ctx, egressKey{}, g)
}

func egressGuardFrom(ctx context.Context) *httpx.EgressGuard {
	g, _ := ctx.Value(egressKey{}).(*httpx.EgressGuard)
	return g
}

// Send implements Transport.
func (t SMTPTransport) Send(ctx context.Context, smtp SMTP, from string, msg Message) (string, error) {
	m := mail.NewMsg()
	if err := m.From(from); err != nil {
		return "", err
	}
	if err := m.To(msg.To); err != nil {
		return "", err
	}
	m.Subject(msg.Subject)
	m.SetBodyString(mail.TypeTextPlain, msg.Text)
	if msg.HTML != "" {
		m.AddAlternativeString(mail.TypeTextHTML, msg.HTML)
	}
	m.SetMessageID()
	m.SetDate()

	timeout := t.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	opts := []mail.Option{mail.WithTimeout(timeout)}
	guard := egressGuardFrom(ctx)
	switch {
	case guard != nil && smtp.Port == 465:
		// go-mail's WithSSL only wraps its OWN dialer, so implicit TLS is
		// done over the guarded conn here; with TLSOpportunistic go-mail
		// sees the *tls.Conn as encrypted (PLAIN/LOGIN allowed) and does
		// not STARTTLS on top of it (an implicit-TLS server offers none).
		tlsCfg := &tls.Config{ServerName: smtp.Host, MinVersion: mail.DefaultTLSMinVersion}
		opts = append(opts, mail.WithTLSPolicy(mail.TLSOpportunistic),
			mail.WithDialContextFunc(func(ctx context.Context, network, addr string) (net.Conn, error) {
				conn, err := guard.DialContext(ctx, network, addr)
				if err != nil {
					return nil, err
				}
				tc := tls.Client(conn, tlsCfg)
				if err := tc.HandshakeContext(ctx); err != nil {
					_ = conn.Close()
					return nil, err
				}
				return tc, nil
			}))
	case guard != nil:
		opts = append(opts, mail.WithTLSPolicy(mail.TLSMandatory), mail.WithDialContextFunc(guard.DialContext))
	case smtp.Port == 465:
		opts = append(opts, mail.WithSSL())
	default:
		opts = append(opts, mail.WithTLSPolicy(mail.TLSMandatory))
	}
	// Port last: WithSSL / WithTLSPolicy reset it to their defaults.
	opts = append(opts, mail.WithPort(smtp.Port),
		mail.WithSMTPAuth(mail.SMTPAuthAutoDiscover), mail.WithUsername(smtp.User), mail.WithPassword(smtp.Pass))
	c, err := mail.NewClient(smtp.Host, opts...)
	if err != nil {
		return "", err
	}
	if err := c.DialAndSendWithContext(ctx, m); err != nil {
		return "", err
	}
	ids := m.GetGenHeader(mail.HeaderMessageID)
	if len(ids) == 0 {
		return "", nil
	}
	return ids[0], nil
}
