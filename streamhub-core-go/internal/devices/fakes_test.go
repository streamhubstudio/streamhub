package devices

import (
	"context"
	"fmt"
	"sync"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
)

// fakeIngress mints deterministic publish endpoints and records teardowns.
type fakeIngress struct {
	mu      sync.Mutex
	n       int
	created []string
	deleted []string
	err     error
}

func (f *fakeIngress) Create(_ context.Context, app, room, protocol string, _ *auth.Principal) (*Publish, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	f.n++
	id := fmt.Sprintf("IN_%d", f.n)
	key := fmt.Sprintf("key%d", f.n)
	p := &Publish{IngressID: id, Room: app + "-" + room, StreamKey: key, InputType: protocol}
	switch protocol {
	case "srt":
		p.Passthrough = true
		p.URL = "srt://media.example.com:8890?streamid=publish:" + app + "/" + key
	default:
		p.URL = "rtmp://media.example.com:1935/live/" + key
	}
	f.created = append(f.created, id)
	return p, nil
}

func (f *fakeIngress) Delete(_ context.Context, _ string, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, id)
	return nil
}

func (f *fakeIngress) deletedIDs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.deleted...)
}
