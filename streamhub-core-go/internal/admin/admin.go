// Package admin is process control (modules/admin, wave-4 §1):
// POST /admin/restart restarts the core via systemd, best-effort.
package admin

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os/exec"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
)

// Runner executes a shell command line (exec in Node); tests inject a fake.
type Runner interface {
	Run(ctx context.Context, cmdline string) (stderr string, err error)
}

// ShellRunner runs the command through /bin/sh -c.
type ShellRunner struct{}

// Run implements Runner.
func (ShellRunner) Run(ctx context.Context, cmdline string) (string, error) {
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", cmdline)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// Module is the admin controller.
type Module struct {
	env    func(string) string
	runner Runner
	log    *slog.Logger
	// delay before dispatching, so the HTTP reply is flushed first.
	delay time.Duration
}

// New builds the module; env reads SYSTEMD_UNIT.
func New(env func(string) string, runner Runner, log *slog.Logger) *Module {
	return &Module{env: env, runner: runner, log: log, delay: 250 * time.Millisecond}
}

// Restarted is the response payload.
type Restarted struct {
	Scheduled bool   `json:"scheduled"`
	Unit      string `json:"unit"`
}

// Register implements api.Module.
func (m *Module) Register(a huma.API) {
	huma.Register(a, *api.Bearer(&huma.Operation{
		OperationID: "AdminController_restart", Method: http.MethodPost, Path: api.Prefix + "/admin/restart",
		Summary:       "Restart the streamhub-core process via systemd (best-effort). Requires a global-scope token (wave-4 §1).",
		Tags:          []string{"admin"},
		DefaultStatus: http.StatusCreated,
	}), func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[Restarted]], error) {
		unit, err := m.Restart(auth.From(ctx))
		if err != nil {
			return nil, err
		}
		return api.OK(Restarted{Scheduled: true, Unit: unit}), nil
	})
}

// Restart gates on a global-scope credential (req.auth.scope; no principal
// = dev without a validator, allowed) and dispatches the restart after the
// reply. Returns the unit name.
func (m *Module) Restart(p *auth.Principal) (string, error) {
	if p != nil && p.LegacyScope() != auth.ScopeGlobal {
		return "", httpx.Forbidden("restart requires a global-scope token")
	}
	unit := m.env("SYSTEMD_UNIT")
	if unit == "" {
		unit = "streamhub-core"
	}
	cmdline := fmt.Sprintf("systemctl restart %s || sudo -n systemctl restart %s", unit, unit)
	time.AfterFunc(m.delay, func() {
		if stderr, err := m.runner.Run(context.Background(), cmdline); err != nil {
			msg := stderr
			if msg == "" {
				msg = err.Error()
			}
			m.log.Error(fmt.Sprintf(`admin restart of "%s" failed: %s`, unit, msg))
		}
	})
	m.log.Warn(fmt.Sprintf(`admin restart of "%s" scheduled`, unit))
	return unit, nil
}
