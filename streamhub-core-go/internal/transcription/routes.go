package transcription

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
)

// Register implements api.Module (transcription.controller.ts: 3 routes
// under /apps/:app/vods/:id).
func (s *Service) Register(a huma.API) {
	op := func(id, method, path, summary, action string, status int) huma.Operation {
		return *authz.Require(api.Bearer(&huma.Operation{
			OperationID: "TranscriptionController_" + id, Method: method,
			Path: api.Prefix + "/apps/{app}/vods/{id}" + path, Summary: summary, Tags: []string{"transcription"},
			DefaultStatus: status,
		}), "vod", action)
	}
	type in struct {
		App string `path:"app"`
		ID  string `path:"id"`
	}
	huma.Register(a, op("transcribe", http.MethodPost, "/transcribe", "Trigger (or re-run) transcription of a ready VOD.", "write", 201),
		func(ctx context.Context, i *in) (*api.Out[api.Envelope[*TranscriptView]], error) {
			id, err := api.ParseNumberIntParam(i.ID)
			if err != nil {
				return nil, err
			}
			v, err := s.Trigger(ctx, i.App, id)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})
	huma.Register(a, op("transcript", http.MethodGet, "/transcript", "A VOD's transcript (status, text, segments, speakers, SRT).", "read", 200),
		func(ctx context.Context, i *in) (*api.Out[api.Envelope[*TranscriptView]], error) {
			id, err := api.ParseNumberIntParam(i.ID)
			if err != nil {
				return nil, err
			}
			v, err := s.GetTranscript(ctx, i.App, id)
			if err != nil {
				return nil, err
			}
			return api.OK(v), nil
		})
	type srtOut struct {
		ContentType        string `header:"Content-Type"`
		ContentDisposition string `header:"Content-Disposition"`
		Body               []byte
	}
	huma.Register(a, op("transcriptSrt", http.MethodGet, "/transcript.srt", "The transcript as an SRT subtitle file.", "read", 200),
		func(ctx context.Context, i *in) (*srtOut, error) {
			id, err := api.ParseNumberIntParam(i.ID)
			if err != nil {
				return nil, err
			}
			name, body, err := s.GetSrt(ctx, i.App, id)
			if err != nil {
				return nil, err
			}
			return &srtOut{"application/x-subrip; charset=utf-8", `attachment; filename="` + name + `"`, []byte(body)}, nil
		})
}
