// Package streamhub is the encoder's StreamHub integration, in two modes:
//
//   - "works today" (Client + Resolver): with a StreamHub base URL and an
//     app-scoped sk_ token the encoder creates/reuses an ingress through the
//     existing REST API (POST /api/v1/apps/{app}/ingress) and publishes RTMP
//     or WHIP to it;
//   - native device plane (Pairing + Link): pairing by code, a dk_ device
//     credential and an outbound WebSocket over which the core pushes publish
//     targets and commands and the encoder reports status. Wire protocol:
//     docs/PAIRING.md (matches streamhub-docs/features/devices.md).
package streamhub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
)

// ErrNotFound is a 404 from StreamHub.
var ErrNotFound = errors.New("not found")

// APIError is a non-2xx answer.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return fmt.Sprintf("streamhub HTTP %d: %s", e.Status, e.Message) }

// Client calls the StreamHub REST API with an sk_ bearer token.
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

func (c *Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 15 * time.Second}
}

// do sends a request and decodes the {data: …} envelope into out.
func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.BaseURL, "/")+path, rd)
	if err != nil {
		return err
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.http().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("%w: %s", ErrNotFound, errMessage(raw))
	}
	if resp.StatusCode/100 != 2 {
		return &APIError{Status: resp.StatusCode, Message: errMessage(raw)}
	}
	if out == nil {
		return nil
	}
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("streamhub: bad JSON: %w", err)
	}
	if len(env.Data) == 0 || string(env.Data) == "null" {
		return json.Unmarshal(raw, out) // tolerate un-enveloped answers
	}
	return json.Unmarshal(env.Data, out)
}

// errMessage extracts a readable error from StreamHub's error shapes.
func errMessage(raw []byte) string {
	var e struct {
		Message any    `json:"message"`
		Error   any    `json:"error"`
		Detail  string `json:"detail"`
	}
	if json.Unmarshal(raw, &e) == nil {
		for _, v := range []any{e.Message, e.Error} {
			switch t := v.(type) {
			case string:
				if t != "" {
					return t
				}
			case map[string]any:
				if m, ok := t["message"].(string); ok {
					return m
				}
			case []any:
				if len(t) > 0 {
					return fmt.Sprint(t[0])
				}
			}
		}
		if e.Detail != "" {
			return e.Detail
		}
	}
	s := strings.TrimSpace(string(raw))
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

// Ingress is the subset of POST/GET /apps/{app}/ingress we use.
type Ingress struct {
	IngressID      string `json:"ingressId"`
	URL            string `json:"url"`
	StreamKey      string `json:"streamKey"`
	StreamKeySnake string `json:"stream_key"`
	RtmpURL        string `json:"rtmp_url"`
	RtmpsURL       string `json:"rtmps_url"`
	RoomName       string `json:"roomName"`
	Room           string `json:"room"`
	Status         string `json:"status"`
	InputType      string `json:"inputType"`
	PlayerURL      string `json:"player_url"`
}

// Key returns the stream key whichever field carries it.
func (i Ingress) Key() string {
	if i.StreamKey != "" {
		return i.StreamKey
	}
	return i.StreamKeySnake
}

// CreateIngress creates an RTMP or WHIP ingress into room.
func (c *Client) CreateIngress(ctx context.Context, app, inputType, room, identity, name string) (Ingress, error) {
	body := map[string]any{"inputType": inputType, "room": room, "participantIdentity": identity, "participantName": name}
	var out Ingress
	err := c.do(ctx, http.MethodPost, "/api/v1/apps/"+url.PathEscape(app)+"/ingress", body, &out)
	return out, err
}

// GetIngress fetches one ingress (ErrNotFound if it is gone).
func (c *Client) GetIngress(ctx context.Context, app, id string) (Ingress, error) {
	var out Ingress
	err := c.do(ctx, http.MethodGet, "/api/v1/apps/"+url.PathEscape(app)+"/ingress/"+url.PathEscape(id), nil, &out)
	return out, err
}

// DeleteIngress deletes an ingress (404 counts as success).
func (c *Client) DeleteIngress(ctx context.Context, app, id string) error {
	err := c.do(ctx, http.MethodDelete, "/api/v1/apps/"+url.PathEscape(app)+"/ingress/"+url.PathEscape(id), nil, nil)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

// Streams lists the app's streams (raw JSON objects).
func (c *Client) Streams(ctx context.Context, app string) ([]map[string]any, error) {
	var out []map[string]any
	err := c.do(ctx, http.MethodGet, "/api/v1/apps/"+url.PathEscape(app)+"/streams", nil, &out)
	return out, err
}

// Resolver implements channel.Resolver with the REST client.
type Resolver struct {
	DeviceID string
	HTTP     *http.Client
}

func (r *Resolver) client(s *config.StreamHubOutput) *Client {
	return &Client{BaseURL: s.BaseURL, Token: s.Token, HTTP: r.HTTP}
}

// Resolve reuses the persisted ingress if it still exists, else creates one,
// and returns the concrete rtmp/whip output to run.
func (r *Resolver) Resolve(ctx context.Context, ch config.Channel, o config.Output) (config.StreamHubOutput, config.Output, error) {
	s := o.StreamHub
	if s == nil {
		return config.StreamHubOutput{}, config.Output{}, errors.New("missing streamhub options")
	}
	cl := r.client(s)
	res := *s
	if s.IngressID != "" && s.ResolvedURL != "" {
		_, err := cl.GetIngress(ctx, s.App, s.IngressID)
		switch {
		case err == nil:
			return res, concrete(o, res), nil
		case !errors.Is(err, ErrNotFound):
			return res, config.Output{}, err
		}
		// gone (deleted in the dashboard): create a new one below
	}
	identity := "encoder-" + r.DeviceID + "-" + ch.ID
	name := "StreamHub Encoder · " + ch.Name
	in, err := cl.CreateIngress(ctx, s.App, s.Protocol, s.Room, identity, name)
	if err != nil {
		return res, config.Output{}, err
	}
	res.IngressID, res.StreamKey = in.IngressID, in.Key()
	switch s.Protocol {
	case "rtmp":
		res.ResolvedURL = in.RtmpURL
		if res.ResolvedURL == "" && in.URL != "" && res.StreamKey != "" {
			res.ResolvedURL = strings.TrimRight(in.URL, "/") + "/" + res.StreamKey
		}
	case "whip":
		res.ResolvedURL = in.URL
	}
	if res.ResolvedURL == "" || res.StreamKey == "" {
		return res, config.Output{}, fmt.Errorf("streamhub returned no publish URL/key for %s ingress %s", s.Protocol, in.IngressID)
	}
	return res, concrete(o, res), nil
}

func concrete(o config.Output, s config.StreamHubOutput) config.Output {
	c := config.Output{ID: o.ID, Name: o.Name, Enabled: true, Type: s.Protocol, URL: s.ResolvedURL}
	if s.Protocol == "whip" {
		c.WHIP = &config.WHIPOptions{BearerToken: s.StreamKey}
	}
	return c
}

// Release deletes the ingress when the output asked for it.
func (r *Resolver) Release(ctx context.Context, o config.Output) error {
	s := o.StreamHub
	if s == nil || !s.DeleteOnRemove || s.IngressID == "" {
		return nil
	}
	return r.client(s).DeleteIngress(ctx, s.App, s.IngressID)
}
