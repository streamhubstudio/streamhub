package plugins

import (
	"context"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/security"
)

// M4: a configSchema field declared `format: "url"` is an outbound target
// the worker calls from the host (the vendor apps' callbackUrl); a PATCH
// pointing it at 10.x / 169.254.x / loopback is a 400 (SSRF egress guard).

const urlFields = `[
 {"key":"callbackUrl","type":"string","label":"Callback","default":"","format":"url"},
 {"key":"note","type":"string","label":"Note","default":""}
]`

func TestPatchGuardsURLFormatFields(t *testing.T) {
	m := shellMeta("hook", "", urlFields)
	m.NeedsWorker, m.Worker = false, nil
	st := newStack(t, m)
	st.svc.Resolve = func(_ context.Context, host string) ([]string, error) {
		if host == "metadata.example" {
			return []string{"169.254.169.254"}, nil
		}
		return []string{"93.184.216.34"}, nil
	}
	if _, err := st.svc.Install(bg, "live", "hook"); err != nil {
		t.Fatal(err)
	}
	t.Setenv(security.CallbackAllowHostsEnv, "")
	patch := func(j string) error {
		_, err := st.svc.Patch(bg, "live", "hook", Patch{Config: cfg(t, j)})
		return err
	}
	want(t, patch(`{"callbackUrl":"http://10.0.0.5/hook"}`), 400, "config field 'callbackUrl' points at a private/loopback/link-local address")
	want(t, patch(`{"callbackUrl":"http://metadata.example/latest"}`), 400, "config field 'callbackUrl' resolves to a private/loopback/link-local address")
	want(t, patch(`{"callbackUrl":"http://[::1]:8080/"}`), 400, "")
	want(t, patch(`{"callbackUrl":"gopher://hooks.example/"}`), 400, "config field 'callbackUrl' scheme 'gopher' is not allowed (allowed: http, https)")
	if v, _ := st.svc.Get(bg, "live", "hook"); v.Config.Get("callbackUrl") != "" {
		t.Fatalf("a rejected URL was stored: %v", v.Config.Get("callbackUrl"))
	}
	// Public, empty, a field without format, and the operator allowlist pass.
	for _, ok := range []string{`{"callbackUrl":"https://hooks.example/x"}`, `{"callbackUrl":""}`, `{"note":"http://10.0.0.5/"}`} {
		if err := patch(ok); err != nil {
			t.Fatalf("%s: %v", ok, err)
		}
	}
	t.Setenv(security.CallbackAllowHostsEnv, "10.0.0.0/8")
	if err := patch(`{"callbackUrl":"http://10.0.0.5/hook"}`); err != nil {
		t.Fatalf("allowlisted: %v", err)
	}
}

func TestFieldFormatValidation(t *testing.T) {
	for raw, wantErr := range map[string]string{
		`{"key":"u","type":"string","label":"U","default":"","format":"url"}`:   "",
		`{"key":"u","type":"secret","label":"U","default":"","format":"url"}`:   "",
		`{"key":"u","type":"string","label":"U","default":"","format":"email"}`: "field 'u' has invalid format 'email'",
		`{"key":"u","type":"number","label":"U","default":0,"format":"url"}`:    "field 'u': format 'url' needs type string or secret",
	} {
		f := cfg(t, raw)
		if got := validateField(f, map[string]bool{}); got != wantErr {
			t.Errorf("%s: got %q, want %q", raw, got, wantErr)
		}
	}
	if fs := parseFields(shellMeta("x", "", urlFields).ConfigSchema); fs[0].Format != "url" || fs[1].Format != "" {
		t.Fatalf("parsed formats: %+v", fs)
	}
}
