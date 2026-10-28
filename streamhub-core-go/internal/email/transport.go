package email

import (
	"context"
	"time"

	mail "github.com/wneessen/go-mail"
)

// SMTPTransport is the real Transport over go-mail. Like nodemailer's
// createTransport({secure: port===465, requireTLS: !secure}) it uses implicit
// TLS on 465 and mandatory STARTTLS elsewhere, auto-discovering the AUTH
// mechanism.
type SMTPTransport struct {
	// Timeout bounds dial + each SMTP command (default 30s).
	Timeout time.Duration
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
	if smtp.Port == 465 {
		opts = append(opts, mail.WithSSL())
	} else {
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
