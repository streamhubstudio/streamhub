package devices

import (
	"context"
	"database/sql"
	"errors"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
)

// DeviceChannel is one device channel linked to a room of the device's app: the
// core owns its ingress (publish URL + key) and pushes it in `config`.
type DeviceChannel struct {
	ID         string `json:"id"`
	Name       string `json:"name,omitempty"`
	Room       string `json:"room"`
	Protocol   string `json:"protocol"`
	IngressID  string `json:"ingressId,omitempty"`
	PublishURL string `json:"publishUrl"`
	StreamKey  string `json:"streamKey"`
	CreatedAt  string `json:"createdAt"`
}

// Ingress mints / tears down the publish endpoint of a channel (the
// POST /apps/:app/ingress service, so quotas, passthrough and MediaMTX all
// apply unchanged).
type Ingress interface {
	Create(ctx context.Context, app, room, protocol string, p *auth.Principal) (*Publish, error)
	Delete(ctx context.Context, app, ingressID string) error
}

// Publish is where a channel pushes.
type Publish struct {
	IngressID   string
	Room        string // the namespaced room the ingress publishes into
	URL         string // full publish URL (key included)
	StreamKey   string
	InputType   string
	Passthrough bool
}

func (s *Service) channels(ctx context.Context, deviceID string) ([]DeviceChannel, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT channel_id, name, room, protocol, ingress_id, publish_url, stream_key, created_at
	    FROM device_channels WHERE device_id = ? ORDER BY channel_id`, deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DeviceChannel{}
	for rows.Next() {
		var (
			c                       DeviceChannel
			name, ingress, url, key sql.NullString
		)
		if err := rows.Scan(&c.ID, &name, &c.Room, &c.Protocol, &ingress, &url, &key, &c.CreatedAt); err != nil {
			return nil, err
		}
		c.Name, c.IngressID, c.PublishURL, c.StreamKey = name.String, ingress.String, url.String, key.String
		out = append(out, c)
	}
	return out, rows.Err()
}

// Channel protocols a device channel can be linked with.
const (
	ProtocolRTMP = "rtmp" // LiveKit plane (transcode, WebRTC + HLS)
	ProtocolSRT  = "srt"  // passthrough plane (-c copy → HLS)
)

// LinkInput is PUT /apps/{app}/devices/{id}/channels/{channel}.
type LinkInput struct {
	Channel, Room, Protocol, Name string
}

// LinkChannel creates (or replaces) the ingress of a device channel and
// pushes the new config. The ingress is minted by the POST /ingress logic
// for the operator's principal, so quotas and the app's ingest settings
// apply as if the operator had created it by hand.
func (s *Service) LinkChannel(ctx context.Context, app, id string, in LinkInput, p *auth.Principal) (*DeviceChannel, error) {
	if err := s.disabled(); err != nil {
		return nil, err
	}
	if err := s.ownDevice(ctx, app, id); err != nil {
		return nil, err
	}
	if s.ingress == nil {
		return nil, httpx.Unavailable("ingress service unavailable")
	}
	pub, err := s.ingress.Create(ctx, app, in.Room, in.Protocol, p)
	if err != nil {
		return nil, err
	}
	var oldIngress sql.NullString
	_ = s.db.QueryRowContext(ctx, `SELECT ingress_id FROM device_channels WHERE device_id = ? AND channel_id = ?`, id, in.Channel).Scan(&oldIngress)
	room := pub.Room
	if room == "" {
		room = in.Room
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO device_channels
	    (device_id, channel_id, app, name, room, protocol, ingress_id, stream_key, publish_url, created_at)
	  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	  ON CONFLICT(device_id, channel_id) DO UPDATE SET
	    name = excluded.name, room = excluded.room, protocol = excluded.protocol, ingress_id = excluded.ingress_id,
	    stream_key = excluded.stream_key, publish_url = excluded.publish_url, created_at = excluded.created_at`,
		id, in.Channel, app, nullable(clip(in.Name)), room, in.Protocol, pub.IngressID, pub.StreamKey, pub.URL, s.iso(s.now()))
	if err != nil {
		s.dropIngress(ctx, app, pub.IngressID) // don't leak the fresh key
		return nil, err
	}
	if oldIngress.Valid && oldIngress.String != pub.IngressID {
		s.dropIngress(ctx, app, oldIngress.String)
	}
	s.pushConfig(ctx, id)
	chans, err := s.channels(ctx, id)
	if err != nil {
		return nil, err
	}
	for i := range chans {
		if chans[i].ID == in.Channel {
			return &chans[i], nil
		}
	}
	return nil, httpx.NotFound("channel not found")
}

// UnlinkResult is DELETE …/channels/{channel}.data.
type UnlinkResult struct {
	ID        string `json:"id"`
	Unlinked  bool   `json:"unlinked"`
	IngressID string `json:"ingressId,omitempty"`
}

// UnlinkChannel drops a channel link and its ingress, then pushes config.
func (s *Service) UnlinkChannel(ctx context.Context, app, id, channel string) (*UnlinkResult, error) {
	if err := s.disabled(); err != nil {
		return nil, err
	}
	if err := s.ownDevice(ctx, app, id); err != nil {
		return nil, err
	}
	var ingress sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT ingress_id FROM device_channels WHERE device_id = ? AND channel_id = ?`, id, channel).Scan(&ingress)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httpx.NotFound("channel not found")
	}
	if err != nil {
		return nil, err
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM device_channels WHERE device_id = ? AND channel_id = ?`, id, channel); err != nil {
		return nil, err
	}
	s.dropIngress(ctx, app, ingress.String)
	s.pushConfig(ctx, id)
	return &UnlinkResult{ID: channel, Unlinked: true, IngressID: ingress.String}, nil
}

// ListChannels is GET …/channels.
func (s *Service) ListChannels(ctx context.Context, app, id string) ([]DeviceChannel, error) {
	if err := s.disabled(); err != nil {
		return nil, err
	}
	if err := s.ownDevice(ctx, app, id); err != nil {
		return nil, err
	}
	return s.channels(ctx, id)
}

// SourceDevice is the `sourceDevice` of a stream fed by a device channel.
type SourceDevice struct {
	DeviceID string `json:"deviceId"`
	Name     string `json:"name"`
	Channel  string `json:"channel"`
}

// SourceDevices maps each linked room of app to its feeding device channel
// (empty while the plane is off).
func (s *Service) SourceDevices(ctx context.Context, app string) map[string]SourceDevice {
	out := map[string]SourceDevice{}
	if !s.enabled {
		return out
	}
	rows, err := s.db.QueryContext(ctx, `SELECT c.room, c.device_id, d.name, c.channel_id FROM device_channels c
	    JOIN devices d ON d.id = c.device_id WHERE c.app = ? ORDER BY c.created_at`, app)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var room string
		var sd SourceDevice
		if rows.Scan(&room, &sd.DeviceID, &sd.Name, &sd.Channel) == nil {
			out[room] = sd
		}
	}
	return out
}

func (s *Service) ownDevice(ctx context.Context, app, id string) error {
	var one int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM devices WHERE id = ? AND app = ?`, id, app).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return httpx.NotFound(msgNotFound)
	}
	return err
}

// dropIngress tears a channel's ingress down (best-effort, logged).
func (s *Service) dropIngress(ctx context.Context, app, ingressID string) {
	if s.ingress == nil || ingressID == "" {
		return
	}
	if err := s.ingress.Delete(context.WithoutCancel(ctx), app, ingressID); err != nil {
		s.log.Warn("device channel ingress teardown failed", "app", app, "ingressId", ingressID, "err", err)
	}
}
