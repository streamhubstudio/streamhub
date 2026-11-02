package email

import (
	"context"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/authn"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/tenancy"
)

// everyUserSmtp answers the same enabled override for any user id.
type everyUserSmtp tenancy.UserSmtp

func (e everyUserSmtp) GetUserSmtp(context.Context, string) *tenancy.UserSmtp {
	row := tenancy.UserSmtp(e)
	return &row
}

// C2 (3.3.3): authentication mail (magic link, invite) never rides on a
// per-user SMTP — whoever configures that SMTP would read the links meant
// for the mailbox. The user tier stays for outgoing notifications only.
func TestAuthMailIgnoresUserSmtp(t *testing.T) {
	ctx := context.Background()
	ten := everyUserSmtp{Enabled: true, Host: "smtp.attacker.test", Port: ptrI(2525), User: "eve", PassEnc: encrypted(t, "eve-pass")}
	s, tr := build(t, map[string]string{"STREAMHUB_SMTP_PASS": "g"}, nil, ten)
	if res := s.Send(ctx, Message{To: "ops@x.io"}, &SendContext{UserID: "u1"}); !res.OK || tr.calls[0].smtp.Host != "smtp.attacker.test" {
		t.Fatal("the per-user tier still serves outgoing notifications")
	}
	tr.calls = nil
	m := AuthMailer{S: s}
	m.SendMagicLink(ctx, "victim@x.io", "https://dash/auth/magic?token=t1")
	m.SendInvite(ctx, "victim@x.io", "https://dash/auth/magic?token=t2", authn.InviteOptions{})
	if len(tr.calls) != 2 {
		t.Fatalf("calls: %+v", tr.calls)
	}
	for _, c := range tr.calls {
		if c.smtp.Host != "mail.wipermax.online" || c.smtp.Pass != "g" {
			t.Fatalf("auth mail must go through the global SMTP, got %+v", c.smtp)
		}
	}
}
