package admin

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

type fakeRunner struct {
	mu   sync.Mutex
	cmds []string
	done chan struct{}
}

func (f *fakeRunner) Run(_ context.Context, cmd string) (string, error) {
	f.mu.Lock()
	f.cmds = append(f.cmds, cmd)
	f.mu.Unlock()
	f.done <- struct{}{}
	return "", nil
}

func TestRestartGate(t *testing.T) {
	cases := []struct {
		name string
		p    *auth.Principal
		ok   bool
	}{
		{"no principal (dev, no validator)", nil, true},
		{"global token", &auth.Principal{Scope: auth.ScopeGlobal, Via: auth.ViaAPIToken}, true},
		{"admin jwt", &auth.Principal{Scope: auth.ScopeGlobal, Via: auth.ViaAdminJWT, IsSuperadmin: true}, true},
		{"app token", &auth.Principal{Scope: auth.ScopeApp, Via: auth.ViaAPIToken}, false},
		{"user jwt (req.auth.scope = app)", &auth.Principal{Scope: auth.ScopeUser, Via: auth.ViaUserJWT, Role: auth.RoleOwner}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := &fakeRunner{done: make(chan struct{}, 1)}
			m := New(func(string) string { return "" }, r, testutil.Log())
			m.delay = time.Millisecond
			unit, err := m.Restart(tc.p)
			if !tc.ok {
				var he *httpx.Error
				if !errors.As(err, &he) || he.Status != http.StatusForbidden || err.Error() != "restart requires a global-scope token" {
					t.Fatalf("want 403, got %v", err)
				}
				return
			}
			if err != nil || unit != "streamhub-core" {
				t.Fatalf("restart = %q, %v", unit, err)
			}
			select {
			case <-r.done:
			case <-time.After(time.Second):
				t.Fatal("restart never dispatched")
			}
			if r.cmds[0] != "systemctl restart streamhub-core || sudo -n systemctl restart streamhub-core" {
				t.Errorf("cmd = %q", r.cmds[0])
			}
		})
	}
}

func TestRestartUnitFromEnv(t *testing.T) {
	r := &fakeRunner{done: make(chan struct{}, 1)}
	m := New(func(k string) string { return map[string]string{"SYSTEMD_UNIT": "skyline-core"}[k] }, r, testutil.Log())
	m.delay = time.Millisecond
	if unit, _ := m.Restart(nil); unit != "skyline-core" {
		t.Fatalf("unit = %q", unit)
	}
	<-r.done
	if r.cmds[0] != "systemctl restart skyline-core || sudo -n systemctl restart skyline-core" {
		t.Errorf("cmd = %q", r.cmds[0])
	}
}
