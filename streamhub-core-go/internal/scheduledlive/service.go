package scheduledlive

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// PublicLookback is how far back a public listing looks so a just-started
// reveal is still shown.
const PublicLookback = 24 * time.Hour

// Topic is the LiveKit data-channel topic of the agenda push.
const Topic = "scheduled-live"

const (
	maxTitle    = 200
	maxMessage  = 500
	maxRoom     = 200
	maxTimezone = 64
)

// LiveKit is the push surface (ListRooms + SendData of the guarded wrapper).
type LiveKit interface {
	ListRooms(ctx context.Context, names []string) ([]livekit.RoomInfo, error)
	SendData(ctx context.Context, room, payload string, o livekit.SendDataOptions) error
}

// Service is ScheduledLiveService. LiveKit/Apps getters may return nil
// (poll-only agenda; app name as room prefix).
type Service struct {
	repo    *Repository
	livekit func() LiveKit
	apps    func() contracts.AppsService
	log     *slog.Logger
	now     func() time.Time
	// push runs a notify (goroutine in prod; tests make it synchronous).
	push func(func())
}

// NewService wires the service.
func NewService(repo *Repository, lk func() LiveKit, apps func() contracts.AppsService, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{repo: repo, livekit: lk, apps: apps, log: log, now: time.Now, push: func(f func()) { go f() }}
}

// CreateInput is the validated CreateScheduledEventDto (nil = absent/null).
type CreateInput struct {
	StartAt              float64
	Timezone             *string
	Room, Title, Message *string
	Enabled              *bool
}

// PatchInput is the validated PatchScheduledEventDto; Has* = key present
// (Node's `!== undefined`; a present null still counts).
type PatchInput struct {
	StartAt                       *float64
	HasTimezone                   bool
	Timezone                      *string
	HasRoom, HasTitle, HasMessage bool
	Room, Title, Message          *string
	Enabled                       *bool
}

// List is the operator agenda.
func (s *Service) List(ctx context.Context, app string) ([]ScheduledEventView, error) {
	return s.repo.List(ctx, app)
}

// ListPublic: sinceMs nil → now − 24h; room "" / blank → every room.
func (s *Service) ListPublic(ctx context.Context, app, room string, sinceMs *float64) ([]ScheduledEventView, error) {
	var cutoff float64
	if sinceMs != nil && !math.IsNaN(*sinceMs) && !math.IsInf(*sinceMs, 0) {
		cutoff = *sinceMs
	} else {
		cutoff = float64(s.now().Add(-PublicLookback).UnixMilli())
	}
	return s.repo.ListPublic(ctx, app, strings.TrimSpace(room), cutoff)
}

// Get is one event or 404.
func (s *Service) Get(ctx context.Context, app string, id int64) (*ScheduledEventView, error) {
	v, err := s.repo.Get(ctx, app, id)
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, httpx.NotFound(fmt.Sprintf("scheduled event '%d' not found", id))
	}
	return v, nil
}

// Create validates + inserts; defaultTimezone backs an omitted/empty timezone.
func (s *Service) Create(ctx context.Context, app string, in CreateInput, defaultTimezone string) (*ScheduledEventView, error) {
	start, err := validateStartAt(in.StartAt)
	if err != nil {
		return nil, err
	}
	tz, err := normalizeTimezone(in.Timezone, defaultTimezone)
	if err != nil {
		return nil, err
	}
	room, err := normalizeText(in.Room, maxRoom, "room")
	if err != nil {
		return nil, err
	}
	title, err := normalizeText(in.Title, maxTitle, "title")
	if err != nil {
		return nil, err
	}
	msg, err := normalizeText(in.Message, maxMessage, "message")
	if err != nil {
		return nil, err
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	created, err := s.repo.Create(ctx, app, Insert{Room: room, Title: title, Message: msg, StartAt: start, Timezone: tz, Enabled: enabled})
	if err != nil {
		return nil, err
	}
	s.notify(app, created.Room)
	return created, nil
}

// Update applies a validated patch (404 on unknown id).
func (s *Service) Update(ctx context.Context, app string, id int64, in PatchInput, defaultTimezone string) (*ScheduledEventView, error) {
	before, err := s.Get(ctx, app, id)
	if err != nil {
		return nil, err
	}
	var p Patch
	if in.StartAt != nil {
		v, err := validateStartAt(*in.StartAt)
		if err != nil {
			return nil, err
		}
		p.StartAt = &v
	}
	if in.HasTimezone {
		tz, err := normalizeTimezone(in.Timezone, defaultTimezone)
		if err != nil {
			return nil, err
		}
		p.Timezone = &tz
	}
	if in.HasRoom {
		if p.Room, err = normalizeText(in.Room, maxRoom, "room"); err != nil {
			return nil, err
		}
		p.SetRoom = true
	}
	if in.HasTitle {
		if p.Title, err = normalizeText(in.Title, maxTitle, "title"); err != nil {
			return nil, err
		}
		p.SetTitle = true
	}
	if in.HasMessage {
		if p.Message, err = normalizeText(in.Message, maxMessage, "message"); err != nil {
			return nil, err
		}
		p.SetMessage = true
	}
	p.Enabled = in.Enabled
	updated, err := s.repo.Update(ctx, app, id, p)
	if err != nil {
		return nil, err
	}
	if updated == nil {
		return nil, httpx.NotFound(fmt.Sprintf("scheduled event '%d' not found", id))
	}
	s.notify(app, updated.Room)
	if strOrNil(before.Room) != strOrNil(updated.Room) {
		s.notify(app, before.Room)
	}
	return updated, nil
}

func strOrNil(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

// ScheduledRemoved is the DELETE result.
type ScheduledRemoved struct {
	Removed bool `json:"removed"`
}

// Remove deletes an event (404 when unknown).
func (s *Service) Remove(ctx context.Context, app string, id int64) (*ScheduledRemoved, error) {
	before, err := s.repo.Get(ctx, app, id)
	if err != nil {
		return nil, err
	}
	ok, err := s.repo.Remove(ctx, app, id)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, httpx.NotFound(fmt.Sprintf("scheduled event '%d' not found", id))
	}
	var room *string
	if before != nil {
		room = before.Room
	}
	s.notify(app, room)
	return &ScheduledRemoved{Removed: true}, nil
}

// agendaPayload keeps Node's key order: type, app, room, at.
type agendaPayload struct {
	Type string  `json:"type"`
	App  string  `json:"app"`
	Room *string `json:"room"`
	At   string  `json:"at"`
}

// notify pushes agenda-updated (best-effort, never fails the mutation).
func (s *Service) notify(app string, eventRoom *string) {
	lk := s.lkSvc()
	if lk == nil {
		return
	}
	at := jsx.ISO(s.now())
	s.push(func() {
		ctx := context.Background()
		prefix := s.roomPrefix(ctx, app)
		var rooms []string
		if eventRoom != nil && *eventRoom != "" {
			rooms = []string{namespaceRoom(prefix, *eventRoom)}
		} else {
			live, err := lk.ListRooms(ctx, nil)
			if err != nil {
				s.log.Warn("agenda push skipped: " + err.Error())
				return
			}
			for _, r := range live {
				if r.Name == prefix || strings.HasPrefix(r.Name, prefix+"-") {
					rooms = append(rooms, r.Name)
				}
			}
		}
		var room *string
		if eventRoom != nil {
			room = eventRoom
		}
		payload, _ := jsx.Stringify(agendaPayload{"agenda-updated", app, room, at})
		topic, reliable := Topic, true
		for _, r := range rooms {
			_ = lk.SendData(ctx, r, payload, livekit.SendDataOptions{Topic: &topic, Reliable: &reliable})
		}
	})
}

func (s *Service) lkSvc() LiveKit {
	if s.livekit == nil {
		return nil
	}
	return s.livekit()
}

func (s *Service) roomPrefix(ctx context.Context, app string) string {
	if s.apps == nil {
		return app
	}
	a := s.apps()
	if a == nil {
		return app
	}
	cfg, err := a.GetConfig(ctx, app)
	if err != nil || cfg.RoomPrefix == "" {
		return app
	}
	return cfg.RoomPrefix
}

func namespaceRoom(prefix, room string) string {
	if room == prefix || strings.HasPrefix(room, prefix+"-") {
		return room
	}
	return prefix + "-" + room
}

func validateStartAt(raw float64) (int64, error) {
	if math.IsNaN(raw) || math.IsInf(raw, 0) || raw != math.Trunc(raw) || raw <= 0 {
		return 0, httpx.BadRequest("startAt must be a positive integer (unix epoch ms, UTC)")
	}
	return int64(raw), nil
}

// jsLen is String#length (UTF-16 code units).
func jsLen(s string) int { return len(utf16.Encode([]rune(s))) }

// jsTrim is String#trim (JS whitespace set).
func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
			return true
		}
		return r >= 0x2000 && r <= 0x200a
	})
}

func normalizeTimezone(raw *string, def string) (string, error) {
	tz := ""
	if raw != nil {
		tz = jsTrim(*raw)
	}
	if tz == "" {
		if d := jsTrim(def); d != "" {
			return d, nil
		}
		return "UTC", nil
	}
	if jsLen(tz) > maxTimezone {
		return "", httpx.BadRequest(fmt.Sprintf("timezone must be <= %d chars", maxTimezone))
	}
	return tz, nil
}

func normalizeText(raw *string, max int, field string) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	s := jsTrim(*raw)
	if s == "" {
		return nil, nil
	}
	if jsLen(s) > max {
		return nil, httpx.BadRequest(fmt.Sprintf("%s must be <= %d chars", field, max))
	}
	return &s, nil
}
