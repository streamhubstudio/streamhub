package config

import "testing"

func TestSamplesURL(t *testing.T) {
	cases := []struct{ samples, public, want string }{
		{"", "https://app.example.com", ""},
		{"https://samples.example.com", "https://app.example.com", "https://samples.example.com"},
		{"https://Samples.Example.com/some/path/", "", "https://samples.example.com"},
		{"http://samples.localhost:8080", "", "http://samples.localhost:8080"},
		{"https://samples.example.com:443", "", "https://samples.example.com"},
		{"samples.example.com", "", ""},                             // not absolute
		{"ftp://samples.example.com", "", ""},                       // not http(s)
		{"https://app.example.com/", "https://app.example.com", ""}, // the dashboard's own origin
	}
	for _, c := range cases {
		t.Setenv("STREAMHUB_SAMPLES_URL", c.samples)
		t.Setenv("PUBLIC_BASE_URL", c.public)
		cfg := Load()
		if cfg.SamplesURL != c.want || cfg.SamplesIsolated() != (c.want != "") {
			t.Errorf("STREAMHUB_SAMPLES_URL=%q PUBLIC_BASE_URL=%q: got %q, want %q", c.samples, c.public, cfg.SamplesURL, c.want)
		}
	}
}

// install.sh only writes STREAMHUB_PUBLIC_URL; every PublicBaseURL consumer
// (WS ingest provisioning, passthrough, grid worker origin) must see it — the
// same fallback samples/cluster already apply.
func TestPublicBaseURLFallsBackToStreamhubPublicURL(t *testing.T) {
	cases := []struct{ base, public, want string }{
		{"", "", ""},
		{"", "https://sh.example.com", "https://sh.example.com"},
		{"https://a.example.com", "https://sh.example.com", "https://a.example.com"},
	}
	for _, c := range cases {
		t.Setenv("PUBLIC_BASE_URL", c.base)
		t.Setenv("STREAMHUB_PUBLIC_URL", c.public)
		if got := Load().PublicBaseURL; got != c.want {
			t.Errorf("PUBLIC_BASE_URL=%q STREAMHUB_PUBLIC_URL=%q: got %q, want %q", c.base, c.public, got, c.want)
		}
	}
}
