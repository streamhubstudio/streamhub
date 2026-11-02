package passthrough

import (
	"context"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/livekit"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/security"
)

// PublishGuard is features.allowed_publisher_cidr (AntMedia
// allowedPublisherCIDR) on the MediaMTX single-port front: the only RTMP/SRT
// path where the core sees the encoder's address (the auth hook's `ip`)
// BEFORE any media flows. Off the front (multi-port model) the encoder talks
// to the LiveKit ingress / the ffmpeg listener directly and nothing reaches
// the core — that limit is documented in features/publisher-restrictions.md.
type PublishGuard struct {
	// Apps lists every app name.
	Apps AppLister
	// CIDRs is the app's resolved allow-list (nil/empty = unrestricted).
	CIDRs func(ctx context.Context, app string) []string
	// Keys finds a LiveKit-plane RTMP stream key in an app's ingress_auth
	// (every RTMP ingress the core mints is registered there).
	Keys interface {
		FindByStreamKey(ctx context.Context, app, streamKey string) (*livekit.IngressAuthRow, error)
	}
}

// Allow is the verdict for a publish of cls from ip. A passthrough key is
// checked against its own app; a LiveKit-plane key against the app that
// minted it (searched among the apps that restrict publishers — a key no
// restricted app owns stays LiveKit's business). A lookup error on a
// restricted app denies (fail closed).
func (g *PublishGuard) Allow(ctx context.Context, cls PathClass, ip string) bool {
	if g == nil || g.CIDRs == nil {
		return true
	}
	switch cls.Kind {
	case PathPassthrough:
		return security.PublisherAllowed(g.CIDRs(ctx, cls.App), ip)
	case PathLivekit:
		if g.Apps == nil || g.Keys == nil {
			return true
		}
		apps, err := g.Apps(ctx)
		if err != nil {
			// No registry, no owner to resolve the key against: an install
			// that restricts nothing must keep ingesting.
			return true
		}
		for _, app := range apps {
			cidrs := g.CIDRs(ctx, app)
			if len(cidrs) == 0 {
				continue
			}
			row, err := g.Keys.FindByStreamKey(ctx, app, cls.Key)
			if err != nil {
				return false
			}
			if row != nil {
				return security.PublisherAllowed(cidrs, ip)
			}
		}
	}
	return true
}
