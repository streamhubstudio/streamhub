package s3

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
)

// s3.storage_class (AntMedia s3StorageClass): the class rides every
// PutObject of the app; unset / unknown never reaches the wire.

func TestStorageClassesAreSDKEnumMembers(t *testing.T) {
	known := map[types.StorageClass]bool{}
	for _, v := range types.StorageClass("").Values() {
		known[v] = true
	}
	for _, c := range StorageClasses {
		if !known[types.StorageClass(c)] {
			t.Fatalf("%q is not an aws-sdk-go-v2 StorageClass", c)
		}
	}
}

func TestNormalizeStorageClass(t *testing.T) {
	for _, c := range []struct {
		in, want string
		ok       bool
	}{
		{"", "", true},
		{"   ", "", true},
		{"STANDARD_IA", "STANDARD_IA", true},
		{" intelligent_tiering ", "INTELLIGENT_TIERING", true},
		{"glacier_ir", "GLACIER_IR", true},
		{"COLD", "", false},
		{"SNOW", "", false},
		{"STANDARD IA", "", false},
	} {
		got, ok := NormalizeStorageClass(c.in)
		if got != c.want || ok != c.ok {
			t.Fatalf("%q → %q,%v (want %q,%v)", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestUploadCarriesStorageClass(t *testing.T) {
	f := &fakeSDK{}
	s := newSvc(f)
	ctx := context.Background()
	file := filepath.Join(t.TempDir(), "a.mp4")
	if err := os.WriteFile(file, []byte("mp4"), 0o600); err != nil {
		t.Fatal(err)
	}

	// default: no class on the request (bucket default, unchanged behaviour)
	if _, err := s.Upload(ctx, baseCfg(), file, "a.mp4", ""); err != nil {
		t.Fatal(err)
	}
	if got := f.puts[0].StorageClass; got != "" {
		t.Fatalf("default upload sent StorageClass %q", got)
	}

	// configured: file and buffer uploads both carry it
	cfg := baseCfg(func(c *contracts.S3Config) { c.StorageClass = "STANDARD_IA" })
	if _, err := s.Upload(ctx, cfg, file, "a.mp4", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UploadBuffer(ctx, cfg, []byte("jpg"), "snap.jpg", ""); err != nil {
		t.Fatal(err)
	}
	for _, p := range f.puts[1:] {
		if p.StorageClass != types.StorageClassStandardIa {
			t.Fatalf("upload %s sent StorageClass %q", *p.Key, p.StorageClass)
		}
	}

	// an unknown class (hand-built config) is dropped, never sent
	bad := baseCfg(func(c *contracts.S3Config) { c.StorageClass = "COLD" })
	if _, err := s.UploadBuffer(ctx, bad, []byte("x"), "x.bin", ""); err != nil {
		t.Fatal(err)
	}
	if got := f.puts[3].StorageClass; got != "" {
		t.Fatalf("unknown class reached the wire: %q", got)
	}
}
