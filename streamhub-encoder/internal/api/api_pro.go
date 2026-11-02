package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/channel"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/notify"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/scte35"
)

// ProManager is the part of the channel manager behind the professional features.
type ProManager interface {
	InsertSCTE35(id string, c scte35.Cue) (uint64, scte35.Cue, error)
	Thumbnail(id string) ([]byte, time.Time, bool)
	ResetLoudness(id string) bool
	Alarms() (active, history []channel.Alarm)
	AckAlarm(id, by string) bool
}

// Notifier is the alarm notification sink.
type Notifier interface {
	Update(cfg notify.Config)
	Test(ctx context.Context) []error
	Stats() notify.Stats
}

type alarmIDIn struct {
	ID string `path:"id" maxLength:"64"`
}

func (s *Server) registerPro(a huma.API, mux *http.ServeMux) {
	pm, _ := s.Manager.(ProManager)

	add(a, http.MethodPost, "/api/v1/channels/{id}/scte35", "channels-scte35", "Insert a SCTE-35 cue (splice_insert immediate/scheduled, time_signal, splice_null). Operator.", 0,
		func(ctx context.Context, in *idRawIn) (*out[map[string]any], error) {
			var c scte35.Cue
			if err := decodeStrict(in.RawBody, &c); err != nil {
				return nil, validationError(err)
			}
			if c.Kind == "" {
				c.Kind = scte35.KindSpliceInsert
			}
			if c.Kind == scte35.KindSpliceInsert && !c.Immediate && c.PreRollMs == 0 {
				c.PreRollMs = scte35.DefaultPreRollMs
			}
			pts, cue, err := pm.InsertSCTE35(in.ID, c)
			if err != nil {
				return nil, huma.Error409Conflict(err.Error())
			}
			return &out[map[string]any]{Body: map[string]any{"eventId": cue.EventID, "scheduledPts": pts, "cue": cue}}, nil
		})

	add(a, http.MethodPost, "/api/v1/channels/{id}/loudness/reset", "channels-loudness-reset", "Restart the integrated loudness (EBU R128) measurement.", 0,
		func(ctx context.Context, in *idIn) (*out[map[string]bool], error) {
			if !pm.ResetLoudness(in.ID) {
				return nil, huma.Error404NotFound("channel " + in.ID + " is not running or has no audio")
			}
			return &out[map[string]bool]{Body: map[string]bool{"reset": true}}, nil
		})

	add(a, http.MethodGet, "/api/v1/alarms", "alarms-list", "Active alarms and the recent history (newest first).", 0,
		func(ctx context.Context, _ *struct{}) (*out[map[string]any], error) {
			act, hist := pm.Alarms()
			return &out[map[string]any]{Body: map[string]any{"active": act, "history": hist}}, nil
		})

	add(a, http.MethodPost, "/api/v1/alarms/{id}/ack", "alarms-ack", "Acknowledge an active alarm. Operator.", 0,
		func(ctx context.Context, in *alarmIDIn) (*out[map[string]bool], error) {
			by := ""
			if p, ok := auth.PrincipalFrom(ctx); ok {
				by = p.Name
			}
			if !pm.AckAlarm(in.ID, by) {
				return nil, huma.Error404NotFound("no active alarm " + in.ID)
			}
			return &out[map[string]bool]{Body: map[string]bool{"acked": true}}, nil
		})

	add(a, http.MethodGet, "/api/v1/notify", "notify-get", "Alarm notification targets (webhooks, SNMP). Admin.", 0,
		func(ctx context.Context, _ *struct{}) (*out[map[string]any], error) {
			c := s.Store.Get()
			nc := notify.Config{Webhooks: []notify.Webhook{}, SNMP: []notify.SNMPTarget{}}
			if c.Settings.Notify != nil {
				nc = config.RedactNotify(notify.Config(*c.Settings.Notify))
			}
			res := map[string]any{"config": nc}
			if s.Notifier != nil {
				res["stats"] = s.Notifier.Stats()
			}
			return &out[map[string]any]{Body: res}, nil
		})

	add(a, http.MethodPut, "/api/v1/notify", "notify-put", "Replace the alarm notification targets. Admin.", 0,
		func(ctx context.Context, in *rawIn) (*out[config.NotifyConfig], error) {
			var nc notify.Config
			if err := json.Unmarshal(in.RawBody, &nc); err != nil {
				return nil, huma.Error400BadRequest("invalid JSON: " + err.Error())
			}
			saved, err := s.Store.Update(func(c *config.Config) error {
				ncc := config.NotifyConfig(nc)
				config.KeepNotifySecrets(c.Settings.Notify, &ncc) // "***" = keep the stored secret
				c.Settings.Notify = &ncc
				return nil
			})
			if err != nil {
				return nil, validationError(err)
			}
			nc = notify.Config(*saved.Settings.Notify)
			if s.Notifier != nil {
				s.Notifier.Update(nc)
			}
			return &out[config.NotifyConfig]{Body: config.NotifyConfig(config.RedactNotify(nc))}, nil
		})

	add(a, http.MethodPost, "/api/v1/notify/test", "notify-test", "Send a test event to every target; returns per-target errors. Admin.", 0,
		func(ctx context.Context, _ *struct{}) (*out[map[string]any], error) {
			if s.Notifier == nil {
				return nil, huma.Error503ServiceUnavailable("notifier not configured")
			}
			errs := s.Notifier.Test(ctx)
			res := make([]string, len(errs))
			for i, e := range errs {
				if e != nil {
					res[i] = e.Error()
				}
			}
			return &out[map[string]any]{Body: map[string]any{"results": res}}, nil
		})

	add(a, http.MethodGet, "/api/v1/system/time", "system-time", "Clock synchronisation status (kernel NTP/PTP discipline via adjtimex).", 0,
		func(ctx context.Context, _ *struct{}) (*out[TimeStatus], error) {
			return &out[TimeStatus]{Body: ReadTimeStatus()}, nil
		})

	// Binary endpoint outside huma (JPEG body).
	mux.HandleFunc("GET /api/v1/channels/{id}/thumbnail.jpg", func(w http.ResponseWriter, r *http.Request) {
		b, at, ok := pm.Thumbnail(r.PathValue("id"))
		if !ok {
			http.Error(w, "no thumbnail (channel stopped?)", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Thumbnail-Age-Ms", strconv.FormatInt(time.Since(at).Milliseconds(), 10))
		_, _ = w.Write(b)
	})
}

// TimeStatus is the kernel clock discipline state.
type TimeStatus struct {
	Synchronized bool    `json:"synchronized"`
	OffsetUs     float64 `json:"offsetUs"`
	MaxErrorUs   int64   `json:"maxErrorUs"`
	EstErrorUs   int64   `json:"estErrorUs"`
	Status       int32   `json:"status"`
	Source       string  `json:"source"`
	Note         string  `json:"note,omitempty"`
}
