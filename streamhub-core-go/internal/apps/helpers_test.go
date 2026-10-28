package apps

import (
	"context"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/s3"
)

// fakeSamples records the wave-4 samples hand-off.
type fakeSamples struct{ calls []string }

func (f *fakeSamples) Generate(_ context.Context, app string) error {
	f.calls = append(f.calls, app)
	return nil
}

// fakeMqtt records dropped MQTT clients.
type fakeMqtt struct{ dropped []string }

func (f *fakeMqtt) DisconnectApp(app string) { f.dropped = append(f.dropped, app) }

type harness struct {
	dataDir string
	env     map[string]string
	samples *fakeSamples
	mqtt    *fakeMqtt
	secrets *s3.SecretsStore
}

// newTestService builds the service over a fresh migrated DATA_DIR with an
// isolated env (no host APP_* refs leak in) and a DNS seam that resolves
// every name to a public address — nothing dials the network.
func newTestService(t *testing.T) (*Service, *harness) {
	t.Helper()
	store, global, dir := testutil.Store(t)
	h := &harness{dataDir: dir, env: map[string]string{}, samples: &fakeSamples{}, mqtt: &fakeMqtt{}}
	env := func(k string) string { return h.env[k] }
	h.secrets = s3.NewSecretsStore(dir, env)
	s := New(Deps{
		Config: &config.Config{DataDir: dir}, Store: store, Global: global,
		S3: s3.New(), Secrets: h.secrets, Samples: h.samples, Mqtt: h.mqtt, Log: testutil.Log(), Env: env,
		Resolve: func(context.Context, string) ([]string, error) { return []string{"93.184.216.34"}, nil },
	})
	return s, h
}
