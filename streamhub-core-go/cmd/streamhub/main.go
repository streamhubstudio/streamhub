// Command streamhub is the StreamHub core: REST API /api/v1, the dashboard
// SPA, HLS/SDK/sample static surfaces. Configuration is the same .env the
// Node core reads (see streamhub-docs/operations/ENV.md).
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/health"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/db"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/server"
)

func main() {
	if code, ok := subcommand(os.Args[1:], os.Stdin, os.Stdout, os.Stderr); ok {
		os.Exit(code)
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "FATAL:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg := config.Load()
	log := newLogger(cfg.LogLevel)
	slog.SetDefault(log)
	for _, w := range cfg.Warnings {
		log.Warn("config: " + w)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	store := db.New(cfg.DataDir, log)
	if err := store.Open(ctx); err != nil {
		return err
	}
	defer store.Close()

	handler, err := buildHandler(ctx, cfg, log, store)
	if err != nil {
		return err
	}

	srv := &http.Server{
		Addr:              net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	errc := make(chan error, 1)
	go func() {
		log.Info("streamhub-core listening", "url", fmt.Sprintf("http://%s%s", srv.Addr, api.Prefix))
		errc <- srv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		log.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			return err
		}
	}
	return nil
}

// buildHandler wires every plane and builds the full HTTP handler. Split
// from run() so boot_test.go can exercise the complete wiring; its extra
// hooks run after the planes' (the guard-coverage test keeps the huma.API).
func buildHandler(ctx context.Context, cfg *config.Config, log *slog.Logger, store *db.Service, hooks ...func(huma.API)) (http.Handler, error) {
	global, err := store.Global(ctx)
	if err != nil {
		return nil, err
	}
	c := &core{cfg: cfg, log: log, store: store, global: global, services: map[string]any{}}
	c.modules = append(c.modules, health.New())
	if err := wirePlanes(ctx, c); err != nil {
		return nil, err
	}
	authn, _ := maybe[api.Authenticator](c, "authn")
	if authn == nil && cfg.IsProduction() {
		return nil, errors.New("no authenticator wired but NODE_ENV=production — refusing to start with authentication disabled")
	}
	return server.Handler(server.Deps{
		Config:     cfg,
		Log:        log,
		Authn:      authn,
		APIHooks:   append(c.apiHooks, hooks...),
		Middleware: c.middleware,
		Modules:    c.modules,
		Counter:    c.hlsCounter,
		HLSGate:    c.hlsGate,
	}), nil
}

func newLogger(level string) *slog.Logger {
	var lv slog.Level
	switch level {
	case "debug", "trace":
		lv = slog.LevelDebug
	case "warn":
		lv = slog.LevelWarn
	case "error", "fatal":
		lv = slog.LevelError
	default:
		lv = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: lv}))
}
