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

// LT4 #9: the HLS latency knobs are strict ranged integers; anything invalid
// keeps the historical default (4 s segments, max-age=1) and warns.
func TestHLSLatencyKnobs(t *testing.T) {
	cases := []struct {
		seg, maxAge      string
		wantSeg, wantAge int
		warns            int
	}{
		{"", "", 4, 1, 0},
		{"2", "0", 2, 0, 0},
		{" 1 ", "10", 1, 10, 0},
		{"10", "3", 10, 3, 0},
		{"0", "-1", 4, 1, 2},
		{"11", "11", 4, 1, 2},
		{"2.5", "1s", 4, 1, 2},
		{"abc", "", 4, 1, 1},
	}
	for _, c := range cases {
		t.Setenv("STREAMHUB_HLS_SEGMENT_S", c.seg)
		t.Setenv("STREAMHUB_HLS_PLAYLIST_MAX_AGE", c.maxAge)
		cfg := Load()
		if cfg.HLSSegmentS != c.wantSeg || cfg.HLSPlaylistMaxAge != c.wantAge || len(cfg.Warnings) != c.warns {
			t.Errorf("seg=%q maxAge=%q: got %d/%d warnings=%q", c.seg, c.maxAge, cfg.HLSSegmentS, cfg.HLSPlaylistMaxAge, cfg.Warnings)
		}
	}
}
