package fleet

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// SendCommandBody is the POST command body as parsed (JS key order kept).
//
// DIVERGENCE (internal design notes): Node's SendCommandDto carries only
// @ApiProperty decorators, so ValidationPipe({whitelist:true}) strips every
// property and Node always answers 400 "body must carry an 'agentId'". Go
// applies the documented contract { agentId, command, args } instead.
type SendCommandBody struct {
	AgentID any
	Command any
	Args    any
}

// parseSendCommand reads { agentId, command, args } from the raw body
// (missing/invalid JSON or a non-object → all undefined).
func parseSendCommand(raw []byte) SendCommandBody {
	var b SendCommandBody
	v, err := y.ParseJSON(raw)
	if err != nil {
		return b
	}
	if m, ok := v.(*y.Map); ok {
		b.AgentID, b.Command, b.Args = m.Get("agentId"), m.Get("command"), m.Get("args")
	}
	return b
}

// Register implements api.Module (FleetController).
func (s *Service) Register(a huma.API) {
	op := func(id, method, path, summary, action string) *huma.Operation {
		return authz.Require(api.Bearer(&huma.Operation{
			OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary, Tags: []string{"fleet"},
		}), "config", action)
	}
	type appIn struct {
		App string `path:"app"`
	}
	type agentIn struct {
		App     string `path:"app"`
		AgentID string `path:"agentId"`
	}
	type cmdIn struct {
		App     string `path:"app"`
		RawBody []byte
	}

	huma.Register(a, *op("FleetController_agents", http.MethodGet, "/apps/{app}/plugins/fleet/agents",
		"Fleet data: all agents in the app + their latest metrics.", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[*FleetData]], error) {
			d, err := s.GetData(ctx, in.App)
			if err != nil {
				return nil, httpx.Internal("Internal server error")
			}
			return api.OK(d), nil
		})

	huma.Register(a, *op("FleetController_agent", http.MethodGet, "/apps/{app}/plugins/fleet/agents/{agentId}",
		"One agent: latest metrics + rolling history + recent commands.", "read"),
		func(ctx context.Context, in *agentIn) (*api.Out[api.Envelope[*FleetAgentDetail]], error) {
			d, err := s.GetAgent(ctx, in.App, in.AgentID)
			if err != nil {
				return nil, httpx.Internal("Internal server error")
			}
			return api.OK(d), nil
		})

	cmd := op("FleetController_command", http.MethodPost, "/apps/{app}/plugins/fleet/command",
		"Publish a command to an agent (restart | ota | config | ping).", "write")
	cmd.DefaultStatus = http.StatusCreated
	huma.Register(a, *cmd, func(ctx context.Context, in *cmdIn) (*api.Out[api.Envelope[*FleetCommandRow]], error) {
		body := parseSendCommand(in.RawBody)
		agentID := ""
		if s, ok := body.AgentID.(string); ok {
			agentID = y.Trim(s)
		}
		if agentID == "" {
			return nil, httpx.BadRequest("body must carry an 'agentId'")
		}
		rec, err := s.SendCommand(ctx, in.App, agentID, body.Command, body.Args)
		var ce *CommandError
		var ie *InactiveError
		switch {
		case errors.As(err, &ce):
			return nil, httpx.BadRequest(ce.Error())
		case errors.As(err, &ie):
			return nil, httpx.Conflict(ie.Error())
		case err != nil:
			return nil, httpx.Internal("Internal server error")
		}
		return api.OK(rec), nil
	})
	a.OpenAPI().Paths[api.Prefix+"/apps/{app}/plugins/fleet/command"].Post.RequestBody.Required = false
}
