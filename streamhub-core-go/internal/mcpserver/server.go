package mcpserver

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Name / Version are the serverInfo the TypeScript server reported.
const (
	Name    = "streamhub"
	Version = "0.2.0"
)

// catalog.json is the tool/resource/prompt catalogue exactly as the
// TypeScript server listed it (names, titles, descriptions, zod-emitted JSON
// Schemas, annotations). It is served verbatim; edit it together with
// tools_table.go when the REST API grows.
//
//go:embed catalog.json
var catalogJSON []byte

type catalog struct {
	Tools             []json.RawMessage `json:"tools"`
	Resources         []json.RawMessage `json:"resources"`
	ResourceTemplates []json.RawMessage `json:"resourceTemplates"`
	Prompts           []json.RawMessage `json:"prompts"`
}

// tool is one registered tool: its raw catalogue entry, parsed input schema
// and endpoint spec.
type tool struct {
	raw    json.RawMessage
	schema *y.Map
	spec   *toolSpec
}

// Server is the StreamHub MCP server.
type Server struct {
	cfg    *Config
	client *Client
	tools  map[string]*tool
	// Pre-rendered list results (key order as the TypeScript server).
	toolsList, resourcesList, templatesList, promptsList json.RawMessage
	sdk                                                  *mcp.Server
}

// New builds the server; hc nil = http.DefaultClient.
func New(cfg *Config, hc *http.Client) (*Server, error) {
	var cat catalog
	if err := json.Unmarshal(catalogJSON, &cat); err != nil {
		return nil, fmt.Errorf("catalog.json: %w", err)
	}
	specs := map[string]*toolSpec{}
	for i := range toolSpecs {
		specs[toolSpecs[i].Name] = &toolSpecs[i]
	}
	s := &Server{cfg: cfg, client: NewClient(cfg.BaseURL, cfg.Token, hc), tools: map[string]*tool{}}
	var listed []json.RawMessage
	for _, raw := range cat.Tools {
		v, err := y.ParseJSON(raw)
		if err != nil {
			return nil, err
		}
		m := v.(*y.Map)
		name, _ := m.Get("name").(string)
		spec := specs[name]
		if spec == nil {
			return nil, fmt.Errorf("catalog tool %q has no endpoint spec", name)
		}
		if spec.Destructive && !cfg.AllowDestructive {
			continue
		}
		schema, _ := m.Get("inputSchema").(*y.Map)
		s.tools[name] = &tool{raw: raw, schema: schema, spec: spec}
		listed = append(listed, raw)
	}
	s.toolsList = listResult("tools", listed)
	s.resourcesList = listResult("resources", cat.Resources)
	s.templatesList = listResult("resourceTemplates", cat.ResourceTemplates)
	s.promptsList = listResult("prompts", cat.Prompts)

	s.sdk = mcp.NewServer(&mcp.Implementation{Name: Name, Version: Version}, &mcp.ServerOptions{
		Capabilities: &mcp.ServerCapabilities{
			Prompts:   &mcp.PromptCapabilities{ListChanged: true},
			Resources: &mcp.ResourceCapabilities{ListChanged: true},
			Tools:     &mcp.ToolCapabilities{ListChanged: true},
		},
	})
	s.sdk.AddReceivingMiddleware(s.middleware)
	return s, nil
}

func listResult(key string, items []json.RawMessage) json.RawMessage {
	if items == nil {
		items = []json.RawMessage{}
	}
	b, _ := json.Marshal(map[string][]json.RawMessage{key: items})
	return b
}

// SDK returns the underlying go-sdk server (transport wiring, tests).
func (s *Server) SDK() *mcp.Server { return s.sdk }

// Run serves over stdio until the client disconnects or ctx ends.
func (s *Server) Run(ctx context.Context) error {
	return s.sdk.Run(ctx, &mcp.StdioTransport{})
}

// rawResult carries a pre-rendered JSON result through the SDK, which only
// accepts its own result types: the embedded value provides mcp.Result,
// MarshalJSON emits the exact bytes.
type rawResult struct {
	mcp.CallToolResult
	raw json.RawMessage
}

func (r *rawResult) MarshalJSON() ([]byte, error) { return r.raw, nil }

func raw(b json.RawMessage) mcp.Result { return &rawResult{raw: b} }

func rawValue(v *y.Map) mcp.Result {
	s, _ := y.Stringify(v)
	return &rawResult{raw: json.RawMessage(s)}
}

// middleware serves the catalogue methods itself (exact TypeScript
// payloads and error texts) and leaves the protocol plumbing (initialize,
// ping, notifications, …) to the SDK.
func (s *Server) middleware(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
		switch method {
		case "tools/list":
			return raw(s.toolsList), nil
		case "resources/list":
			return raw(s.resourcesList), nil
		case "resources/templates/list":
			return raw(s.templatesList), nil
		case "prompts/list":
			return raw(s.promptsList), nil
		case "tools/call":
			p, _ := req.GetParams().(*mcp.CallToolParamsRaw)
			if p == nil {
				break
			}
			return rawValue(s.CallTool(ctx, p.Name, p.Arguments)), nil
		case "resources/read":
			p, _ := req.GetParams().(*mcp.ReadResourceParams)
			if p == nil {
				break
			}
			res, err := s.ReadResource(ctx, p.URI)
			if err != nil {
				return nil, err
			}
			return rawValue(res), nil
		case "prompts/get":
			p, _ := req.GetParams().(*mcp.GetPromptParams)
			if p == nil {
				break
			}
			res, err := s.GetPrompt(p.Name, p.Arguments)
			if err != nil {
				return nil, err
			}
			return rawValue(res), nil
		}
		return next(ctx, method, req)
	}
}

func textContent(text string) []any {
	c := y.NewMap()
	c.Set("type", "text")
	c.Set("text", text)
	return []any{c}
}

func errorResult(text string) *y.Map {
	m := y.NewMap()
	m.Set("content", textContent(text))
	m.Set("isError", true)
	return m
}

// CallTool runs one tool and returns the CallToolResult object. Every
// failure (unknown tool, invalid input, API error) is an isError result.
func (s *Server) CallTool(ctx context.Context, name string, args json.RawMessage) *y.Map {
	t := s.tools[name]
	if t == nil {
		return errorResult(fmt.Sprintf("MCP error -32602: Tool %s not found", name))
	}
	var parsed any = y.Undefined
	if len(args) > 0 && string(args) != "null" {
		v, err := y.ParseJSON(args)
		if err != nil {
			return errorResult(fmt.Sprintf("MCP error -32602: Input validation error: Invalid arguments for tool %s: invalid JSON", name))
		}
		parsed = v
	} else if t.schema != nil {
		parsed = y.NewMap()
	}
	a, issues := validateArgs(t.schema, parsed)
	if issues != nil {
		return errorResult(fmt.Sprintf("MCP error -32602: Input validation error: Invalid arguments for tool %s: %s", name, Pretty(issues)))
	}
	result, err := t.spec.run(ctx, s.client, a)
	if err != nil {
		return errorResult(errorText(err))
	}
	m := y.NewMap()
	m.Set("content", textContent(toText(result)))
	return m
}

// errorText is the TypeScript server's errorText.
func errorText(err error) string {
	var ae *APIError
	if errors.As(err, &ae) {
		status := fmt.Sprintf("HTTP %d", ae.Status)
		if ae.Status == 0 {
			status = "network error"
		}
		return fmt.Sprintf("StreamHub API error (%s): %s", status, ae.Message)
	}
	return "Error: " + err.Error()
}

var appTemplate = regexp.MustCompile(`^streamhub://apps/([^/]+)$`)

// ReadResource serves streamhub://apps, streamhub://health and the
// streamhub://apps/{app} template.
func (s *Server) ReadResource(ctx context.Context, uri string) (*y.Map, error) {
	var path string
	switch {
	case uri == "streamhub://apps":
		path = "/apps"
	case uri == "streamhub://health":
		path = "/health"
	case appTemplate.MatchString(uri):
		path = "/apps/" + jsx.EncodeURIComponent(appTemplate.FindStringSubmatch(uri)[1])
	default:
		return nil, &jsonrpc.Error{Code: -32602, Message: fmt.Sprintf("MCP error -32602: Resource %s not found", uri)}
	}
	v, err := s.client.Do(ctx, http.MethodGet, path, nil, y.Undefined)
	if err != nil {
		return nil, &jsonrpc.Error{Code: -32603, Message: err.Error()}
	}
	c := y.NewMap()
	c.Set("uri", uri)
	c.Set("mimeType", "application/json")
	c.Set("text", toText(v))
	out := y.NewMap()
	out.Set("contents", []any{c})
	return out, nil
}

// GetPrompt renders go-live / diagnose-stream.
func (s *Server) GetPrompt(name string, args map[string]string) (*y.Map, error) {
	if name != "go-live" && name != "diagnose-stream" {
		return nil, &jsonrpc.Error{Code: -32602, Message: fmt.Sprintf("MCP error -32602: Prompt %s not found", name)}
	}
	app, hasApp := args["app"]
	if !hasApp {
		var l issueList
		l.invalidType("string", y.Undefined, []any{"app"})
		return nil, &jsonrpc.Error{Code: -32602, Message: fmt.Sprintf("MCP error -32602: Invalid arguments for prompt %s: %s", name, Pretty(l.items))}
	}
	room := args["room"]
	var text string
	if name == "go-live" {
		text = goLivePrompt(s.client.Origin(), app, room)
	} else {
		text = diagnosePrompt(app, room)
	}
	msg := y.NewMap()
	msg.Set("role", "user")
	content := y.NewMap()
	content.Set("type", "text")
	content.Set("text", text)
	msg.Set("content", content)
	out := y.NewMap()
	out.Set("messages", []any{msg})
	return out, nil
}

func goLivePrompt(origin, app, room string) string {
	r := room
	if r == "" {
		r = "<room>"
	}
	inRoom, roomArg := "", ""
	if room != "" {
		inRoom = fmt.Sprintf(` in room "%s"`, room)
		roomArg = fmt.Sprintf(`, room: "%s"`, room)
	}
	return strings.Join([]string{
		fmt.Sprintf(`Help me go live on the StreamHub app "%s"%s. Follow this runbook with the streamhub tools:`, app, inRoom),
		"",
		fmt.Sprintf(`1. Verify the app exists with get_app (name: "%s"); if it does not, ask me before creating it with create_app.`, app),
		fmt.Sprintf(`2. Create an RTMP ingest with create_ingress (app: "%s", inputType: "rtmp"%s).`, app, roomArg),
		`3. Give me the returned rtmp_url and stream_key formatted for OBS: Settings > Stream > Service "Custom", Server = rtmp_url, Stream Key = stream_key.`,
		fmt.Sprintf(`4. After I start streaming, confirm it is on air with list_ingress (status should be "publishing") and list_streams (app: "%s").`, app),
		fmt.Sprintf(`5. Share playback: the public player is %s/play/%s/%s (if the app has publicPlayback disabled, mint a signed URL with sign_playback_url). For embedding use %s/embed/%s/%s.`, origin, app, r, origin, app, r),
		"6. Ask me if I want to record: if yes, use start_recording (roomName = the ingress room) and tell me the recording id so we can stop it later.",
	}, "\n")
}

func diagnosePrompt(app, room string) string {
	inRoom, roomArg := "", ""
	if room != "" {
		inRoom = fmt.Sprintf(` (room "%s")`, room)
		roomArg = fmt.Sprintf(`, room: "%s"`, room)
	}
	return strings.Join([]string{
		fmt.Sprintf(`A stream in StreamHub app "%s"%s is not working. Diagnose it with the streamhub tools:`, app, inRoom),
		"",
		"1. get_health — is the server itself up?",
		fmt.Sprintf(`2. list_ingress (app: "%s"%s) — check status (inactive/buffering/publishing/error), bitrate and dimensions. "inactive" means the encoder never connected: re-check rtmp_url + stream_key.`, app, roomArg),
		fmt.Sprintf(`3. list_streams and list_rooms (app: "%s") — is the room live, are there participants?`, app),
		fmt.Sprintf(`4. get_app_stats (app: "%s") — viewers, ingress and the 24h log rollup.`, app),
		fmt.Sprintf(`5. query_logs (app: "%s", level: "error", limit: 50) — recent errors around ingest/egress.`, app),
		"6. Summarize the root cause and the fix; typical culprits: wrong stream key, encoder pushing to the wrong host/port (RTMP is 1935 on the server IP, not behind the proxy), app recording/transcoding misconfig, or the room name not matching the app prefix.",
	}, "\n")
}
