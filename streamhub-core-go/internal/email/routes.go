package email

import (
	"context"
	"fmt"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authn"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
)

// Register implements api.Module: POST /apps/:app/smtp/test
// (EmailSmtpTestController — probes the app's own SMTP).
func (s *Service) Register(a huma.API) {
	type input struct {
		App     string `path:"app"`
		RawBody []byte
	}
	huma.Register(a, *authz.Require(api.Bearer(&huma.Operation{
		OperationID:   "EmailSmtpTestController_test",
		Method:        http.MethodPost,
		Path:          api.Prefix + "/apps/{app}/smtp/test",
		Summary:       "Send a probe email using this app's configured SMTP.",
		Tags:          []string{"apps"},
		DefaultStatus: http.StatusCreated,
	}), "config", "write"), func(ctx context.Context, in *input) (*api.Out[api.Envelope[SendResult]], error) {
		b, err := validate.Parse(in.RawBody)
		if err != nil {
			return nil, err
		}
		// TestSmtpDto: @IsEmail() @MaxLength(200) to
		b.Field("to").MaxLength(200).IsEmail()
		if err := b.Err(); err != nil {
			return nil, err
		}
		if s.apps == nil {
			return api.OK(SendResult{OK: false, Error: "apps_service_unavailable"}), nil
		}
		rec, err := s.apps.Get(ctx, in.App)
		if err != nil {
			return nil, err
		}
		if rec == nil {
			return nil, httpx.NotFound(fmt.Sprintf("app %q not found", in.App))
		}
		return api.OK(s.TestAppSmtp(ctx, in.App, b.String("to"))), nil
	})
}

// AuthMailer adapts the service to the auth plane's Mailer.
type AuthMailer struct{ S *Service }

var _ authn.Mailer = AuthMailer{}

// SendMagicLink implements authn.Mailer.
func (m AuthMailer) SendMagicLink(ctx context.Context, email, url string, sc authn.SendContext) authn.SendResult {
	return m.S.SendMagicLink(ctx, email, url, &SendContext{UserID: sc.UserID})
}

// SendInvite implements authn.Mailer.
func (m AuthMailer) SendInvite(ctx context.Context, email, url string, o authn.InviteOptions, sc authn.SendContext) authn.SendResult {
	return m.S.SendInvite(ctx, email, url, InviteOptions{TeamName: o.TeamName, Role: o.Role, InvitedBy: o.InvitedBy}, &SendContext{UserID: sc.UserID})
}

// TestUserSMTP implements authn.Mailer.
func (m AuthMailer) TestUserSMTP(ctx context.Context, userID, to string) authn.SendResult {
	return m.S.TestUserSmtp(ctx, userID, to)
}
