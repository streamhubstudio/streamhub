// Package health is the liveness probe (modules/health). GET /api/v1/health
// is public. GET /api/v1/stats lands with the livekit port (it needs the
// room/egress/ingress clients).
package health

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/version"
)

// Status is the /health body (HealthResponseDto).
type Status struct {
	Status        string `json:"status" enum:"ok"`
	Up            bool   `json:"up"`
	Version       string `json:"version"`
	Ts            string `json:"ts" doc:"ISO-8601 timestamp of the response"`
	UptimeSeconds int64  `json:"uptimeSeconds"`
}

// Module serves the health routes.
type Module struct {
	startedAt time.Time
}

// New records the process start time.
func New() *Module { return &Module{startedAt: time.Now()} }

// Health returns the liveness payload.
func (m *Module) Health() Status {
	return Status{
		Status:        "ok",
		Up:            true,
		Version:       version.Get(),
		Ts:            time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		UptimeSeconds: int64(time.Since(m.startedAt) / time.Second),
	}
}

type healthOutput struct{ Body Status }

// Register implements api.Module.
func (m *Module) Register(a huma.API) {
	huma.Register(a, *api.Public(&huma.Operation{
		OperationID: "getHealth",
		Method:      http.MethodGet,
		Path:        api.Prefix + "/health",
		Summary:     "Liveness probe (public, no auth)",
		Description: "Returns up/version/ts. Used by load balancers and the UI.",
		Tags:        []string{"health"},
	}), func(ctx context.Context, _ *struct{}) (*healthOutput, error) {
		return &healthOutput{Body: m.Health()}, nil
	})
}
