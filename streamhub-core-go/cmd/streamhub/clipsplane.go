package main

import (
	"context"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/clips"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/recording"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/streams"
)

// The clips plane (G6): instant/event clips cut from the HLS/DVR segments
// into VODs (4 routes under /apps/{app}/…/clips).
//
// Needs "apps", "streams" (stream → room) and "recording" (the upload flow +
// the vods repository). Optional, lazy: "callbacks" (clip.ready/failed),
// "logs". Provides "clips" (*clips.Service — Streamflow's action.clip).
// The boot recovery of interrupted jobs runs from c.starters only.
func init() {
	registerPlane(46, "clips", func(ctx context.Context, c *core) error {
		rec := need[*recording.Service](c, "recording")
		strm, _ := maybe[*streams.Service](c, "streams")
		svc := clips.New(clips.Deps{
			Apps:      need[contracts.AppsService](c, "apps"),
			Streams:   clipStreams{strm},
			Publisher: rec,
			Vods:      rec.Vods(),
			Store:     clips.NewStore(c.store.App),
			Callbacks: lazy[clips.Dispatcher](c, "callbacks"),
			Logs:      lazy[clips.Logs](c, "logs"),
			Log:       c.log,
		})
		provide(c, "clips", svc)
		c.modules = append(c.modules, &clips.Routes{Svc: svc})
		c.starters = append(c.starters, svc.Start)
		return nil
	})
}

// clipStreams is the clips module's view of the streams service.
type clipStreams struct{ s *streams.Service }

func (a clipStreams) StreamRoom(ctx context.Context, app, id string) (string, bool, error) {
	if a.s == nil {
		return "", false, nil
	}
	rec, err := a.s.Get(ctx, app, id)
	if err != nil || rec == nil {
		return "", false, err
	}
	return rec.Room, true, nil
}

var (
	_ clips.Publisher = (*recording.Service)(nil)
	_ clips.VodFinder = (*recording.Vods)(nil)
)
