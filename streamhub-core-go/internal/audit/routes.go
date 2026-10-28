package audit

import (
	"context"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
)

// Routes is the read API over the trail (audit.controller.ts): GET
// /system/audit and /system/audit/verify, global scope only.
type Routes struct{ svc *Service }

// NewRoutes wraps the service.
func NewRoutes(s *Service) *Routes { return &Routes{svc: s} }

type listInput struct {
	Action string `query:"action"`
	Actor  string `query:"actor"`
	Result string `query:"result"`
	From   string `query:"from"`
	To     string `query:"to"`
	Limit  string `query:"limit"`
	Offset string `query:"offset"`
}

// Register implements api.Module.
func (m *Routes) Register(a huma.API) {
	huma.Register(a, *api.Bearer(&huma.Operation{
		OperationID: "AuditController_list",
		Method:      http.MethodGet,
		Path:        api.Prefix + "/system/audit",
		Summary:     "Query the append-only security audit trail (newest first).",
		Tags:        []string{"system"},
	}), func(ctx context.Context, in *listInput) (*api.Out[api.Envelope[AuditPage]], error) {
		if err := api.RequireGlobal(ctx, api.GlobalScopeMessage); err != nil {
			return nil, err
		}
		q := Query{
			Action: strings.TrimSpace(in.Action),
			Actor:  strings.TrimSpace(in.Actor),
			From:   strings.TrimSpace(in.From),
			To:     strings.TrimSpace(in.To),
			Limit:  queryInt(in.Limit),
			Offset: queryInt(in.Offset),
		}
		switch in.Result {
		case "success", "failure", "deny":
			q.Result = in.Result
		}
		page, err := m.svc.Query(ctx, q)
		if err != nil {
			return nil, httpx.Internal("Internal server error")
		}
		return api.OK(page), nil
	})

	huma.Register(a, *api.Bearer(&huma.Operation{
		OperationID: "AuditController_verify",
		Method:      http.MethodGet,
		Path:        api.Prefix + "/system/audit/verify",
		Summary:     "Verify the audit-trail hash chain (tamper evidence).",
		Tags:        []string{"system"},
	}), func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[AuditChainReport]], error) {
		if err := api.RequireGlobal(ctx, api.GlobalScopeMessage); err != nil {
			return nil, err
		}
		return api.OK(m.svc.VerifyChain(ctx)), nil
	})
}

// queryInt is Number.parseInt over an optional query string (NaN → unset).
func queryInt(raw string) *int {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	n, ok := config.ParseIntPrefix(raw)
	if !ok {
		return nil
	}
	return &n
}

// RequestIP is requestIp(req): the proxy-validated client IP or nil.
func RequestIP(ctx context.Context) *string { return Str(httpx.ClientIP(api.Request(ctx))) }

// RecordCtx records e with the actor taken from the request principal and
// the request IP (the common controller call shape).
func (s *Service) RecordCtx(ctx context.Context, e Event) {
	if s == nil {
		return
	}
	e = e.WithActor(auth.From(ctx))
	e.IP = RequestIP(ctx)
	s.Record(ctx, e)
}
