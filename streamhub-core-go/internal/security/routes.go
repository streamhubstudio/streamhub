package security

import (
	"context"
	"net/http"
	"strconv"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
)

// Routes is the superadmin /security admin API (security.controller.ts).
type Routes struct {
	settings Settings
	rules    *Rules
	rep      *Reputation
	audit    *audit.Service // optional
}

// NewRoutes builds the controller.
func NewRoutes(s Settings, rules *Rules, rep *Reputation, a *audit.Service) *Routes {
	return &Routes{s, rules, rep, a}
}

// SecurityStatus is GET /security/status.
type SecurityStatus struct {
	Mode          string `json:"mode"`
	AllowlistOnly bool   `json:"allowlistOnly"`
	Autoban       struct {
		Enabled     bool `json:"enabled"`
		MaxOffenses int  `json:"maxOffenses"`
		WindowS     int  `json:"windowS"`
		BaseTTLS    int  `json:"baseTtlS"`
		Track404    bool `json:"track404"`
	} `json:"autoban"`
	Counts struct {
		Rules            int `json:"rules"`
		AllowRules       int `json:"allowRules"`
		BlockRules       int `json:"blockRules"`
		ActiveBans       int `json:"activeBans"`
		TrackedOffenders int `json:"trackedOffenders"`
	} `json:"counts"`
}

func op(id, method, path, summary string) *huma.Operation {
	return api.Bearer(&huma.Operation{OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary, Tags: []string{"security"}})
}

func guard(ctx context.Context) error { return api.RequireGlobal(ctx, api.GlobalScopeMessage) }

// Register implements api.Module.
func (m *Routes) Register(a huma.API) {
	huma.Register(a, *op("SecurityController_status", http.MethodGet, "/security/status",
		"Network-security overview: mode, allowlist-only flag, auto-ban config and counts."),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[SecurityStatus]], error) {
			if err := guard(ctx); err != nil {
				return nil, err
			}
			var st SecurityStatus
			s := m.settings
			st.Mode, st.AllowlistOnly = s.Mode, s.AllowlistOnly
			st.Autoban.Enabled, st.Autoban.MaxOffenses, st.Autoban.WindowS = s.AutobanEnabled, s.AutobanMaxOffenses, s.AutobanWindowS
			st.Autoban.BaseTTLS, st.Autoban.Track404 = s.AutobanBaseTTLS, s.Autoban404Enabled
			st.Counts.Rules, st.Counts.AllowRules, st.Counts.BlockRules = m.rules.Counts()
			st.Counts.ActiveBans, st.Counts.TrackedOffenders = m.rep.Counts()
			return api.OK(st), nil
		})

	huma.Register(a, *op("SecurityController_listRules", http.MethodGet, "/security/ip-rules",
		"List the global IP allow/block rules (newest first)."),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[[]IPRule]], error) {
			if err := guard(ctx); err != nil {
				return nil, err
			}
			rules, err := m.rules.List(ctx)
			if err != nil {
				return nil, err
			}
			return api.OK(rules), nil
		})

	type ruleMeta struct {
		CIDR       string  `json:"cidr"`
		RuleAction string  `json:"ruleAction"`
		Note       *string `json:"note"`
	}
	addOp := op("SecurityController_addRule", http.MethodPost, "/security/ip-rules",
		"Add an allow/block rule (IPv4/IPv6 CIDR or bare IP).")
	addOp.DefaultStatus = http.StatusCreated
	huma.Register(a, *addOp, func(ctx context.Context, in *api.RawBodyInput) (*api.Out[api.Envelope[*IPRule]], error) {
		b, err := validate.Parse(in.RawBody)
		if err != nil {
			return nil, err
		}
		ValidateCreateIPRule(b)
		if err := b.Err(); err != nil {
			return nil, err
		}
		if err := guard(ctx); err != nil {
			return nil, err
		}
		var createdBy *string
		if p := auth.From(ctx); p != nil {
			createdBy = &p.UserID
		}
		rule, err := m.rules.Add(ctx, b.String("cidr"), b.String("action"), b.StringPtr("note"), createdBy)
		if err != nil {
			return nil, err
		}
		m.audit.RecordCtx(ctx, audit.Event{
			Action: "security.ip_rule.create", TargetType: audit.Str("ip_rule"), TargetID: audit.Str(itoa(rule.ID)),
			Meta: ruleMeta{rule.CIDR, rule.Action, rule.Note},
		})
		return api.OK(rule), nil
	})

	type idInput struct {
		ID string `path:"id"`
	}
	type ipRuleDeleted struct {
		ID      int64 `json:"id"`
		Deleted bool  `json:"deleted"`
	}
	huma.Register(a, *op("SecurityController_removeRule", http.MethodDelete, "/security/ip-rules/{id}",
		"Delete a rule. 404 when unknown."),
		func(ctx context.Context, in *idInput) (*api.Out[api.Envelope[ipRuleDeleted]], error) {
			id, err := api.ParseIntParam(in.ID)
			if err != nil {
				return nil, err
			}
			if err := guard(ctx); err != nil {
				return nil, err
			}
			if err := m.rules.Remove(ctx, id); err != nil {
				return nil, err
			}
			m.audit.RecordCtx(ctx, audit.Event{Action: "security.ip_rule.delete", TargetType: audit.Str("ip_rule"), TargetID: audit.Str(itoa(id))})
			return api.OK(ipRuleDeleted{id, true}), nil
		})

	type securityBans struct {
		Active []BanView `json:"active"`
		Recent []BanView `json:"recent"`
	}
	huma.Register(a, *op("SecurityController_bans", http.MethodGet, "/security/bans",
		"Auto-ban state: active bans plus recently expired ones (7-day history)."),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[securityBans]], error) {
			if err := guard(ctx); err != nil {
				return nil, err
			}
			recent, err := m.rep.RecentBans(ctx, 50)
			if err != nil {
				return nil, err
			}
			return api.OK(securityBans{m.rep.ActiveBans(), recent}), nil
		})

	type ipInput struct {
		IP string `path:"ip"`
	}
	type ipUnbanned struct {
		IP       string `json:"ip"`
		Unbanned bool   `json:"unbanned"`
	}
	huma.Register(a, *op("SecurityController_unban", http.MethodPost, "/security/bans/{ip}/unban",
		"Lift a ban immediately (also resets its escalation level)."),
		func(ctx context.Context, in *ipInput) (*api.Out[api.Envelope[ipUnbanned]], error) {
			if err := guard(ctx); err != nil {
				return nil, err
			}
			if !m.rep.Unban(ctx, in.IP) {
				return nil, httpx.NotFound("no ban record for " + in.IP)
			}
			m.audit.RecordCtx(ctx, audit.Event{Action: "security.unban", TargetType: audit.Str("ip"), TargetID: audit.Str(in.IP)})
			return api.OK(ipUnbanned{in.IP, true}), nil
		})

	huma.Register(a, *op("SecurityController_offenses", http.MethodGet, "/security/offenses",
		"Recent offenders inside the sliding window (heaviest first)."),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[[]OffenderView]], error) {
			if err := guard(ctx); err != nil {
				return nil, err
			}
			return api.OK(m.rep.Offenders(50)), nil
		})
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

// ValidateCreateIPRule applies the CreateIpRuleDto rules.
func ValidateCreateIPRule(b *validate.Body) {
	b.Field("cidr").MaxLength(64).IsString()
	b.Field("action").IsIn("allow", "block")
	b.Optional("note").MaxLength(300).IsString()
}
