package main

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"net/http"
	"sort"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/web"
)

// Wiring is split into "planes" (one file per group of modules, e.g.
// appsplane.go) that self-register from init(). This keeps main.go stable
// while modules are ported in parallel, and replaces Nest's DI container:
//
//   - a plane builds its services, Provide()s the ones other modules need,
//     and appends its api.Modules / hooks / middleware to the core;
//   - later planes Need() what earlier ones provided (order decides).
//
// Provide/Need are keyed by name and type-checked at boot: a missing or
// mistyped dependency fails startup loudly instead of at request time.

// core is what every plane receives.
type core struct {
	cfg    *config.Config
	log    *slog.Logger
	store  *db.Service
	global *sql.DB

	services   map[string]any
	modules    []api.Module
	apiHooks   []func(huma.API)
	middleware []func(http.Handler) http.Handler
	// hlsCounter receives /hls bytes per app (net-metrics plane sets it).
	hlsCounter web.ByteCounter
	// starters run after every plane is wired (background timers, boot
	// re-arm), in plane order, with the root context.
	starters []func(context.Context)
	// binds run after every plane is wired and BEFORE the shadow check: late
	// cross-plane wiring (setter injection of a service a later plane
	// provides) that starts no work, so it also runs under STREAMHUB_SHADOW.
	binds []func()
}

type plane struct {
	order int
	name  string
	wire  func(ctx context.Context, c *core) error
}

var planes []plane

// registerPlane is called from a plane file's init(). Lower order wires
// first; the auth plane is 10, apps 20, CRUD 30, media 40, stateful 50.
func registerPlane(order int, name string, wire func(context.Context, *core) error) {
	planes = append(planes, plane{order: order, name: name, wire: wire})
}

// provide publishes a service for later planes.
func provide[T any](c *core, name string, v T) {
	if _, dup := c.services[name]; dup {
		panic(fmt.Sprintf("service %q provided twice", name))
	}
	c.services[name] = v
}

// need fetches a service provided by an earlier plane.
func need[T any](c *core, name string) T {
	v, ok := c.services[name]
	if !ok {
		panic(fmt.Sprintf("service %q not provided (plane order?)", name))
	}
	t, ok := v.(T)
	if !ok {
		var zero T
		panic(fmt.Sprintf("service %q is %T, want %T", name, v, zero))
	}
	return t
}

// maybe fetches an optional service (zero value when absent).
func maybe[T any](c *core, name string) (T, bool) {
	v, ok := c.services[name].(T)
	return v, ok
}

// wirePlanes runs every registered plane in order.
func wirePlanes(ctx context.Context, c *core) error {
	sort.SliceStable(planes, func(i, j int) bool { return planes[i].order < planes[j].order })
	for _, p := range planes {
		if err := p.wire(ctx, c); err != nil {
			return fmt.Errorf("plane %s: %w", p.name, err)
		}
	}
	for _, b := range c.binds {
		b()
	}
	// STREAMHUB_SHADOW=1 serves HTTP but starts NO background work (timers,
	// watchdogs, reconcilers, worker resume, boot re-arm). Used to run the Go
	// core side by side with the live Node core on the same LiveKit/host
	// without either one acting on shared media state twice.
	if c.cfg.EnvBool("STREAMHUB_SHADOW", false) {
		c.log.Warn("shadow mode: background starters disabled", "skipped", len(c.starters))
		return nil
	}
	for _, s := range c.starters {
		s(ctx)
	}
	return nil
}
