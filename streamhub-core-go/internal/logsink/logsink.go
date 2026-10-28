// Package logsink is the narrow LogsServiceContract.write surface the
// outbound modules (callbacks, mqtt, net-metrics, latency monitor) log
// through. The logs module (server_logs table + MQTT log forwarding) is not
// ported yet: until it provides a Writer, lines go to slog.
package logsink

import (
	"context"
	"log/slog"
	"sync/atomic"
)

// Writer is LogsServiceContract.write(level, source, message, meta).
// Implementations must never panic.
type Writer interface {
	Write(level, source, message string, meta map[string]any)
}

// Slog adapts a *slog.Logger (the fallback when no logs service is wired).
type Slog struct{ Log *slog.Logger }

// Write implements Writer.
func (s Slog) Write(level, source, message string, meta map[string]any) {
	if s.Log == nil {
		return
	}
	attrs := make([]any, 0, 2+2*len(meta))
	attrs = append(attrs, "source", source)
	for k, v := range meta {
		attrs = append(attrs, k, v)
	}
	s.Log.Log(context.Background(), level2slog(level), message, attrs...)
}

func level2slog(level string) slog.Level {
	switch level {
	case "trace", "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error", "fatal":
		return slog.LevelError
	}
	return slog.LevelInfo
}

// Or returns w, or the slog fallback when w is nil.
func Or(w Writer, log *slog.Logger) Writer {
	if w != nil {
		return w
	}
	return Slog{Log: log}
}

// Switch is a Writer whose target can be replaced at runtime: the outbound
// modules are wired before the logs module exists (which itself needs the
// MQTT publisher), so the logs plane calls Set once it is built.
type Switch struct {
	target atomic.Pointer[Writer]
}

// NewSwitch starts on fallback.
func NewSwitch(fallback Writer) *Switch {
	s := &Switch{}
	s.Set(fallback)
	return s
}

// Set replaces the target (nil is ignored).
func (s *Switch) Set(w Writer) {
	if w != nil {
		s.target.Store(&w)
	}
}

// Write implements Writer.
func (s *Switch) Write(level, source, message string, meta map[string]any) {
	if w := s.target.Load(); w != nil {
		(*w).Write(level, source, message, meta)
	}
}
