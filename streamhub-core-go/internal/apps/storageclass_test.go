package apps

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	y "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
)

// s3.storage_class (3.4.0): off by default, absent on disk and in JSON
// until set; resolved upper-cased, garbage = provider default.

func TestStorageClassOffByDefault(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "fresh"})
	cfg, err := s.GetConfig(bg, "fresh")
	if err != nil {
		t.Fatal(err)
	}
	// INVARIANT: an untouched app's JSON and yaml carry no class (pre-3.4
	// responses / the recorded parity oracle are unchanged).
	if b, _ := json.Marshal(cfg); cfg.S3.StorageClass != "" || strings.Contains(string(b), "storageClass") {
		t.Errorf("GET config leaks storageClass when unset: %s", b)
	}
	if m, _ := s.GetS3(bg, "fresh"); m != nil {
		if b, _ := json.Marshal(m); strings.Contains(string(b), "storageClass") {
			t.Errorf("GET s3 leaks storageClass when unset: %s", b)
		}
	}
	if raw, _ := readYAML(t, s, "fresh"); strings.Contains(raw, "storage_class") {
		t.Error("scaffold yaml carries storage_class")
	}
}

func TestResolveStorageClass(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "raw"})
	for _, c := range []struct{ yaml, want string }{
		{"standard_ia", "STANDARD_IA"},
		{"' GLACIER_IR '", "GLACIER_IR"},
		{"COLD", ""},
		{"3", ""},
	} {
		if _, err := s.PutRawConfig(bg, "raw", "name: raw\nroom_prefix: raw\ns3:\n  storage_class: "+c.yaml+"\n"); err != nil {
			t.Fatal(err)
		}
		if cfg, _ := s.GetConfig(bg, "raw"); cfg.S3.StorageClass != c.want {
			t.Errorf("storage_class %s → %q, want %q", c.yaml, cfg.S3.StorageClass, c.want)
		}
	}
}

func TestStorageClassDto(t *testing.T) {
	for _, c := range []struct {
		body string
		want []string
	}{
		{`{"storageClass":"COLD"}`, []string{storageClassMessage}},
		{`{"storageClass":3}`, []string{"storageClass must be a string"}},
	} {
		_, err := parseSetS3([]byte(c.body))
		if got := messages(t, err); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s:\n got %q\nwant %q", c.body, got, c.want)
		}
	}
}

func TestSetS3StorageClass(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "scl"})
	set := func(body string) *AppMaskedS3 {
		t.Helper()
		dto, err := parseSetS3([]byte(body))
		if err != nil {
			t.Fatal(err)
		}
		m, err := s.SetS3(bg, "scl", dto.in)
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	m := set(`{"storageClass":"intelligent_tiering"}`)
	if m.StorageClass != "INTELLIGENT_TIERING" {
		t.Fatalf("masked = %q", m.StorageClass)
	}
	if _, disk := readYAML(t, s, "scl"); at(disk, "s3", "storage_class") != "INTELLIGENT_TIERING" {
		t.Errorf("disk = %v", at(disk, "s3", "storage_class"))
	}
	if cfg, _ := s.GetConfig(bg, "scl"); cfg.S3.StorageClass != "INTELLIGENT_TIERING" {
		t.Errorf("resolved = %q (the uploads read this)", cfg.S3.StorageClass)
	}
	// a PUT without the field keeps it; "" clears it (and the key)
	if m = set(`{"bucket":"b"}`); m.StorageClass != "INTELLIGENT_TIERING" {
		t.Errorf("untouched PUT cleared the class")
	}
	if m = set(`{"storageClass":""}`); m.StorageClass != "" {
		t.Errorf("clear = %q", m.StorageClass)
	}
	if _, disk := readYAML(t, s, "scl"); !y.IsUndefined(at(disk, "s3", "storage_class")) {
		t.Error("cleared class must leave no key on disk")
	}
}
