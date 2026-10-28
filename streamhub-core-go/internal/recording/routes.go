package recording

import (
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"

	"github.com/danielgtaylor/huma/v2"
	"github.com/dlclark/regexp2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Module serves recording.controller.ts (11 routes).
type Module struct {
	S       *Service
	Stats   *Stats
	streams Streams
	quotas  Quotas
}

// NewModule wires the controller.
func NewModule(s *Service, streams Streams, quotas Quotas) *Module {
	return &Module{S: s, Stats: NewStats(s, streams), streams: streams, quotas: quotas}
}

func op(id, method, path, summary string, status int) *huma.Operation {
	o := api.Bearer(&huma.Operation{OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary, Tags: []string{"recording"}})
	if status != 0 {
		o.DefaultStatus = status
	}
	return o
}

type appIn struct {
	App string `path:"app"`
}

type idIn struct {
	App string `path:"app"`
	ID  string `path:"id"`
}

type idBodyIn struct {
	App     string `path:"app"`
	ID      string `path:"id"`
	RawBody []byte
}

type appBodyIn struct {
	App     string `path:"app"`
	RawBody []byte
}

var recordModes = []string{"composite", "track", "audio"}

func parseBody(raw []byte, rules func(*validate.Body)) (*validate.Body, error) {
	b, err := validate.Parse(raw)
	if err != nil {
		return nil, err
	}
	rules(b)
	if err := b.Err(); err != nil {
		return nil, err
	}
	return b, nil
}

func recordStreamRules(b *validate.Body) {
	b.Optional("recordMode").IsIn(recordModes...)
	b.Optional("participantIdentity").MaxLength(200).IsString()
}

func startRules(b *validate.Body) {
	b.Field("roomName").MaxLength(200).IsString()
	b.Optional("streamId").MaxLength(200).IsString()
	recordStreamRules(b)
}

// Register implements api.Module.
func (m *Module) Register(a huma.API) {
	huma.Register(a, *authz.Require(op("RecordingController_recordStreamStart", http.MethodPost, "/apps/{app}/streams/{id}/record/start",
		"Start recording a live stream (egress over the stream room).", http.StatusCreated), "recording", "start"),
		func(ctx context.Context, in *idBodyIn) (*api.Out[api.Envelope[*RecordingHandle]], error) {
			b, err := parseBody(in.RawBody, recordStreamRules)
			if err != nil {
				return nil, err
			}
			if err := m.quotas.EnforceRecordingMinutes(ctx, auth.From(ctx)); err != nil {
				return nil, err
			}
			st, err := m.streams.Lookup(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			if st == nil {
				return nil, httpx.NotFound(fmt.Sprintf("stream '%s' not found", in.ID))
			}
			if st.Room == "" {
				return nil, httpx.BadRequest(fmt.Sprintf("stream '%s' has no room to record", in.ID))
			}
			participant := b.String("participantIdentity")
			if participant == "" {
				participant = st.Participant
			}
			h, err := m.S.StartForStream(ctx, in.App, in.ID, st.Room, b.String("recordMode"), participant)
			if err != nil {
				return nil, err
			}
			return api.OK(h), nil
		})

	huma.Register(a, *authz.Require(op("RecordingController_recordStreamStop", http.MethodPost, "/apps/{app}/streams/{id}/record/stop",
		"Stop the in-progress recording of a live stream.", http.StatusCreated), "recording", "stop"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[*RecordingHandle]], error) {
			h, err := m.S.StopForStream(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(h), nil
		})

	huma.Register(a, *authz.Require(op("RecordingController_start", http.MethodPost, "/apps/{app}/recording/start",
		"Start a recording (egress) for a room of the app.", http.StatusCreated), "recording", "start"),
		func(ctx context.Context, in *appBodyIn) (*api.Out[api.Envelope[*RecordingHandle]], error) {
			b, err := parseBody(in.RawBody, startRules)
			if err != nil {
				return nil, err
			}
			if err := m.quotas.EnforceRecordingMinutes(ctx, auth.From(ctx)); err != nil {
				return nil, err
			}
			h, err := m.S.StartRecording(ctx, StartInput{
				AppName: in.App, RoomName: b.String("roomName"), StreamID: b.String("streamId"),
				RecordMode: b.String("recordMode"), ParticipantIdentity: b.String("participantIdentity"),
			})
			if err != nil {
				return nil, err
			}
			return api.OK(h), nil
		})

	huma.Register(a, *authz.Require(op("RecordingController_stop", http.MethodPost, "/apps/{app}/recording/{id}/stop",
		"Stop an in-progress recording.", http.StatusCreated), "recording", "stop"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[*RecordingHandle]], error) {
			h, err := m.S.StopRecording(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(h), nil
		})

	huma.Register(a, *authz.Require(op("RecordingController_listVods", http.MethodGet, "/apps/{app}/vods",
		"List VODs of the app with filters/ordering/paging + total count.", 0), "vod", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[vodPageOut], error) {
			q, err := parseListQuery(api.Request(ctx).URL.Query())
			if err != nil {
				return nil, err
			}
			page, err := m.S.ListVods(ctx, in.App, q)
			if err != nil {
				return nil, err
			}
			return api.JSON(vodPageOut{page.Data, page.Total, page.Limit, page.Offset, nil}), nil
		})

	huma.Register(a, *authz.Require(op("RecordingController_probeVod", http.MethodPost, "/apps/{app}/vods/{id}/probe",
		"Probe a VOD with ffprobe and backfill duration_s / width / height / format.", http.StatusCreated), "vod", "write"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[*ProbedVod]], error) {
			id, err := api.ParseIntParam(in.ID)
			if err != nil {
				return nil, err
			}
			v, err := m.S.ProbeVod(ctx, in.App, id)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	type vodDownloadOut struct {
		URL              string `json:"url"`
		Filename         string `json:"filename"`
		ExpiresInSeconds *int64 `json:"expiresInSeconds"`
	}
	huma.Register(a, *authz.Require(op("RecordingController_downloadVod", http.MethodGet, "/apps/{app}/vods/{id}/download",
		"Get a download URL for a VOD (attachment).", 0), "vod", "read"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[vodDownloadOut]], error) {
			id, err := api.ParseIntParam(in.ID)
			if err != nil {
				return nil, err
			}
			dl, err := m.S.GetDownload(ctx, in.App, id)
			if err != nil {
				return nil, err
			}
			if dl.Source == "s3" {
				exp := dl.ExpiresInSeconds
				return api.OK(vodDownloadOut{dl.URL, dl.Filename, &exp}), nil
			}
			url := fmt.Sprintf("/api/v1/apps/%s/vods/%d/raw", jsx.EncodeURIComponent(in.App), id)
			return api.OK(vodDownloadOut{url, dl.Filename, nil}), nil
		})

	huma.Register(a, *authz.Require(op("RecordingController_downloadVodRaw", http.MethodGet, "/apps/{app}/vods/{id}/raw",
		"Stream a local VOD file as an attachment download.", 0), "vod", "read"),
		func(ctx context.Context, in *idIn) (*huma.StreamResponse, error) {
			id, err := api.ParseIntParam(in.ID)
			if err != nil {
				return nil, err
			}
			raw, err := m.S.OpenLocalRaw(ctx, in.App, id)
			if err != nil {
				return nil, err
			}
			return &huma.StreamResponse{Body: func(hctx huma.Context) {
				f, err := os.Open(raw.LocalPath)
				if err != nil {
					api.WriteError(hctx, httpx.Internal("Internal server error"))
					return
				}
				defer f.Close()
				hctx.SetHeader("Content-Type", raw.ContentType)
				hctx.SetHeader("Content-Disposition", `attachment; filename="`+raw.Filename+`"`)
				hctx.SetStatus(http.StatusOK)
				_, _ = io.Copy(hctx.BodyWriter(), f)
			}}, nil
		})

	huma.Register(a, *authz.Require(op("RecordingController_getStats", http.MethodGet, "/apps/{app}/stats",
		"Per-app stats: live streams/viewers, VOD counts/storage, ingress and a 24h log rollup.", 0), "app", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[*RecordingAppStats]], error) {
			st, err := m.Stats.Stats(ctx, in.App)
			if err != nil {
				return nil, err
			}
			return api.OK(st), nil
		})

	huma.Register(a, *authz.Require(op("RecordingController_getVod", http.MethodGet, "/apps/{app}/vods/{id}",
		"VOD detail with playback URLs plus post-transcode variants.", 0), "vod", "read"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[*VodDetail]], error) {
			id, err := api.ParseIntParam(in.ID)
			if err != nil {
				return nil, err
			}
			v, err := m.S.GetVod(ctx, in.App, id)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})

	type vodDeleteResult struct {
		ID           int64 `json:"id"`
		Deleted      bool  `json:"deleted"`
		S3Deleted    int64 `json:"s3Deleted"`
		LocalDeleted bool  `json:"localDeleted"`
	}
	huma.Register(a, *authz.Require(op("RecordingController_deleteVod", http.MethodDelete, "/apps/{app}/vods/{id}",
		"Delete a VOD with cascade: app.db row + S3 object + S3 snapshot + local file/snapshot.", 0), "vod", "delete"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[vodDeleteResult]], error) {
			id, err := api.ParseIntParam(in.ID)
			if err != nil {
				return nil, err
			}
			r, err := m.S.DeleteVodCascade(ctx, in.App, id)
			if err != nil {
				return nil, err
			}
			return api.OK(vodDeleteResult{id, true, r.S3Deleted, r.LocalDeleted}), nil
		})

	// A missing body validates as {} in Nest, not huma's "body is required".
	for _, item := range a.OpenAPI().Paths {
		if o := item.Post; o != nil && o.RequestBody != nil && bodyOps[o.OperationID] {
			o.RequestBody.Required = false
		}
	}
}

var bodyOps = map[string]bool{"RecordingController_recordStreamStart": true, "RecordingController_start": true}

type vodPageOut struct {
	Data   []VodRecord `json:"data"`
	Total  int64       `json:"total"`
	Limit  int64       `json:"limit"`
	Offset int64       `json:"offset"`
	Error  *struct{}   `json:"error"`
}

// iso8601 is validator.js isISO8601 (non-strict), lookaheads/backrefs and all.
var iso8601 = regexp2.MustCompile(`^([\+-]?\d{4}(?!\d{2}\b))((-?)((0[1-9]|1[0-2])(\3([12]\d|0[1-9]|3[01]))?|W([0-4]\d|5[0-3])(-?[1-7])?|(00[1-9]|0[1-9]\d|[12]\d{2}|3([0-5]\d|6[1-6])))([T\s]((([01]\d|2[0-3])((:?)[0-5]\d)?|24:?00)([\.,]\d+(?!:))?)?(\17[0-5]\d([\.,]\d+)?)?([zZ]|([\+-])([01]\d|2[0-3]):?([0-5]\d)?)?)?)?$`, regexp2.ECMAScript)

func isISO8601(s string) bool {
	ok, err := iso8601.MatchString(s)
	return err == nil && ok
}

// parseListQuery validates ListVodsDto (query strings; limit/offset via
// @Type(() => Number) + @IsInt; `all` via its @Transform).
func parseListQuery(v map[string][]string) (ListQuery, error) {
	var q ListQuery
	var msgs []string
	single := func(name string) (string, bool, bool) { // value, present, isArray
		vals, ok := v[name]
		if !ok {
			return "", false, false
		}
		if len(vals) != 1 {
			return "", true, true
		}
		return vals[0], true, false
	}
	in := func(val string, allowed ...string) bool {
		for _, a := range allowed {
			if val == a {
				return true
			}
		}
		return false
	}
	if s, ok, arr := single("room"); ok {
		switch {
		case arr:
			msgs = append(msgs, "room must be shorter than or equal to 200 characters", "room must be a string")
		case jsx.UTF16Len(s) > 200:
			msgs = append(msgs, "room must be shorter than or equal to 200 characters")
		default:
			q.Room = &s
		}
	}
	if s, ok, arr := single("status"); ok {
		if arr || !in(s, "recording", "uploading", "ready", "failed") {
			msgs = append(msgs, "status must be one of the following values: recording, uploading, ready, failed")
		} else {
			q.Status = &s
		}
	}
	for _, name := range []string{"since", "until"} {
		if s, ok, arr := single(name); ok {
			if arr || !isISO8601(s) {
				msgs = append(msgs, name+" must be a valid ISO 8601 date string")
			} else if name == "since" {
				q.Since = &s
			} else {
				q.Until = &s
			}
		}
	}
	if s, ok, arr := single("order"); ok {
		if arr || !in(s, "started_at", "size_bytes", "id") {
			msgs = append(msgs, "order must be one of the following values: started_at, size_bytes, id")
		} else {
			q.Order = s
		}
	}
	if s, ok, arr := single("dir"); ok {
		if arr || !in(s, "asc", "desc") {
			msgs = append(msgs, "dir must be one of the following values: asc, desc")
		} else {
			q.Dir = s
		}
	}
	if s, ok, arr := single("all"); ok && !arr {
		q.All = s == "1" || s == "true"
	}
	for _, name := range []string{"limit", "offset"} {
		if s, ok, arr := single(name); ok {
			f := math.NaN()
			if !arr {
				f = yamljs.StringToNumber(s)
			}
			if math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) {
				msgs = append(msgs, name+" must be an integer number")
				continue
			}
			if name == "limit" {
				q.Limit = &f
			} else {
				q.Offset = &f
			}
		}
	}
	if len(msgs) > 0 {
		return q, httpx.NestValidation(msgs)
	}
	return q, nil
}
