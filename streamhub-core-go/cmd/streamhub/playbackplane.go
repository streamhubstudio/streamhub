package main

import (
	"context"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/playback"
)

// The playback plane (G2, 3.4.0): the anonymous-playback guard — signed HLS
// for private apps (the /hls gate + the direct-serve /hls-auth subrequest),
// features.geo against the optional local GeoLite2 base, and the
// features.play_auth webhook.
//
// Provides: "playback" (*playback.Guard), read by the livekit token routes,
// the streams playlistUrl and the MediaMTX publish hook; also hands the
// guard to the static mounts (core.hlsGate).
func init() {
	registerPlane(21, "playback", func(ctx context.Context, c *core) error {
		var geo playback.CountryLookup
		if path := c.cfg.Env("STREAMHUB_GEOIP_DB"); path == "" {
			c.log.Info("geo-blocking off: STREAMHUB_GEOIP_DB not set (features.geo is ignored)")
		} else if db, err := playback.OpenGeoIP(path); err != nil {
			c.log.Warn("geo-blocking off: cannot open STREAMHUB_GEOIP_DB", "path", path, "error", err.Error())
		} else {
			c.log.Info("geo-blocking base loaded", "path", path)
			geo = db
		}
		g := playback.New(playback.Options{
			Apps: need[contracts.AppsService](c, "apps"), Secret: c.cfg.JWTSecret, Geo: geo, Log: c.log,
		})
		provide(c, "playback", g)
		c.hlsGate = g
		return nil
	})
}
