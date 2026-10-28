package s3

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
)

// ---- fakes ----------------------------------------------------------------

type fakeSDK struct {
	mu       sync.Mutex
	puts     []*awss3.PutObjectInput
	putBody  []int64
	heads    []*awss3.HeadObjectInput
	deletes  []*awss3.DeleteObjectInput
	gets     []*awss3.GetObjectInput
	expiries []int64 // seconds, as the presigner received them
	err      error   // returned (once) by the next call
	etag     *string
	builds   int
}

func (f *fakeSDK) takeErr() error {
	e := f.err
	f.err = nil
	return e
}

func (f *fakeSDK) PutObject(_ context.Context, in *awss3.PutObjectInput, _ ...func(*awss3.Options)) (*awss3.PutObjectOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.puts = append(f.puts, in)
	if err := f.takeErr(); err != nil {
		return nil, err
	}
	return &awss3.PutObjectOutput{ETag: f.etag}, nil
}

func (f *fakeSDK) HeadObject(_ context.Context, in *awss3.HeadObjectInput, _ ...func(*awss3.Options)) (*awss3.HeadObjectOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.heads = append(f.heads, in)
	return &awss3.HeadObjectOutput{}, f.takeErr()
}

func (f *fakeSDK) DeleteObject(_ context.Context, in *awss3.DeleteObjectInput, _ ...func(*awss3.Options)) (*awss3.DeleteObjectOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deletes = append(f.deletes, in)
	return &awss3.DeleteObjectOutput{}, f.takeErr()
}

func (f *fakeSDK) PresignGetObject(_ context.Context, in *awss3.GetObjectInput, optFns ...func(*awss3.PresignOptions)) (*v4.PresignedHTTPRequest, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var o awss3.PresignOptions
	for _, fn := range optFns {
		fn(&o)
	}
	secs := int64(o.Expires.Seconds())
	f.gets = append(f.gets, in)
	f.expiries = append(f.expiries, secs)
	if err := f.takeErr(); err != nil {
		return nil, err
	}
	return &v4.PresignedHTTPRequest{URL: fmt.Sprintf("https://presigned.test/%s?exp=%d", *in.Key, secs), Method: http.MethodGet}, nil
}

type statusErr struct{ code int }

func (e statusErr) Error() string       { return fmt.Sprintf("http %d", e.code) }
func (e statusErr) HTTPStatusCode() int { return e.code }

func newSvc(f *fakeSDK) *Service {
	s := New()
	s.NewClient = func(contracts.S3Config) (Client, Presigner) {
		f.builds++
		return f, f
	}
	s.Env = func(string) string { return "" }
	s.Resolve = func(context.Context, string) ([]string, error) { return nil, errors.New("no DNS in tests") }
	return s
}

func baseCfg(mut ...func(*contracts.S3Config)) contracts.S3Config {
	c := contracts.S3Config{
		Provider: "aws", Bucket: "my-bucket", Region: "us-east-1",
		Prefix: "streamhub/live", AccessKey: "AKIA_TEST", SecretKey: "secret_test",
	}
	for _, m := range mut {
		m(&c)
	}
	return c
}

func status(t *testing.T, err error) int {
	t.Helper()
	var he *httpx.Error
	if !errors.As(err, &he) {
		t.Fatalf("not an httpx.Error: %v", err)
	}
	return he.Status
}

func tmpClip(t *testing.T) (dir, file string) {
	dir = t.TempDir()
	file = filepath.Join(dir, "clip.mp4")
	if err := os.WriteFile(file, []byte("hello-mp4-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir, file
}

// ---- upload + key assembly --------------------------------------------------

func TestUploadKeyAssembly(t *testing.T) {
	cases := []struct {
		name   string
		prefix string
		key    string
		want   string
	}{
		{"prepends prefix", "streamhub/live", "clip.mp4", "streamhub/live/clip.mp4"},
		{"no double prefix", "streamhub/live", "streamhub/live/clip.mp4", "streamhub/live/clip.mp4"},
		{"slash-boundary look-alike", "streamhub/live", "streamhub/live-extra/clip.mp4", "streamhub/live/streamhub/live-extra/clip.mp4"},
		{"leading slashes, empty prefix", "", "/clip.mp4", "clip.mp4"},
		{"prefix slashes trimmed", "/streamhub/live/", "//clip.mp4", "streamhub/live/clip.mp4"},
		{"key equal to prefix", "p", "p", "p"},
	}
	_, file := tmpClip(t)
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := &fakeSDK{}
			res, err := newSvc(f).Upload(context.Background(), baseCfg(func(x *contracts.S3Config) { x.Prefix = c.prefix }), file, c.key, "video/mp4")
			if err != nil {
				t.Fatal(err)
			}
			if res.Key != c.want || *f.puts[0].Key != c.want {
				t.Fatalf("key %q / put %q, want %q", res.Key, *f.puts[0].Key, c.want)
			}
			if *f.puts[0].Bucket != "my-bucket" || *f.puts[0].ContentType != "video/mp4" {
				t.Fatalf("put %+v", f.puts[0])
			}
		})
	}
}

func TestUploadResult(t *testing.T) {
	_, file := tmpClip(t)
	f := &fakeSDK{etag: strPtr(`"deadbeef"`)}
	var hook []string
	s := newSvc(f)
	s.OnUpload = func(p string, ok bool, n int64) { hook = append(hook, fmt.Sprintf("%s %v %d", p, ok, n)) }
	res, err := s.Upload(context.Background(), baseCfg(), file, "clip.mp4", "video/mp4")
	if err != nil {
		t.Fatal(err)
	}
	want := contracts.S3UploadResult{
		Key: "streamhub/live/clip.mp4", Bucket: "my-bucket", SizeBytes: 15, ETag: "deadbeef",
		URL: "https://my-bucket.s3.us-east-1.amazonaws.com/streamhub/live/clip.mp4",
	}
	if *res != want {
		t.Fatalf("%+v", *res)
	}
	if *f.puts[0].ContentLength != 15 {
		t.Fatalf("content length %d", *f.puts[0].ContentLength)
	}
	if len(hook) != 1 || hook[0] != "aws true 15" {
		t.Fatalf("metrics %v", hook)
	}
	// No ETag → omitted.
	f.etag = nil
	res, _ = s.Upload(context.Background(), baseCfg(), file, "clip.mp4", "")
	if res.ETag != "" {
		t.Fatalf("etag %q", res.ETag)
	}
}

func TestGuessContentType(t *testing.T) {
	cases := map[string]string{
		"thumb.jpg": "image/jpeg", "a.JPEG": "image/jpeg", "x.m3u8": "application/vnd.apple.mpegurl",
		"seg.ts": "video/mp2t", "v.mkv": "video/x-matroska", "d.json": "application/json",
		"noext": "application/octet-stream", ".mp4": "application/octet-stream", "dir.mp4/": "video/mp4",
		"a.bin": "application/octet-stream",
	}
	for k, want := range cases {
		if got := guessContentType(k); got != want {
			t.Errorf("%q → %q want %q", k, got, want)
		}
	}
	dir, _ := tmpClip(t)
	jpg := filepath.Join(dir, "thumb.jpg")
	_ = os.WriteFile(jpg, []byte("x"), 0o644)
	f := &fakeSDK{}
	if _, err := newSvc(f).Upload(context.Background(), baseCfg(), jpg, "thumb.jpg", ""); err != nil {
		t.Fatal(err)
	}
	if *f.puts[0].ContentType != "image/jpeg" {
		t.Fatalf("ct %q", *f.puts[0].ContentType)
	}
}

func TestUploadLocalFileErrors(t *testing.T) {
	dir, _ := tmpClip(t)
	f := &fakeSDK{}
	s := newSvc(f)
	missing := filepath.Join(dir, "nope.mp4")
	_, err := s.Upload(context.Background(), baseCfg(), missing, "x.mp4", "")
	if status(t, err) != 500 || err.Error() != fmt.Sprintf("S3 upload: cannot read local file %s: ENOENT: no such file or directory, stat '%s'", missing, missing) {
		t.Fatalf("missing: %v", err)
	}
	_, err = s.Upload(context.Background(), baseCfg(), dir, "x.mp4", "")
	if status(t, err) != 500 || err.Error() != fmt.Sprintf("S3 upload: cannot read local file %s: S3 upload source is not a file: %s", dir, dir) {
		t.Fatalf("dir: %v", err)
	}
	if len(f.puts) != 0 {
		t.Fatal("SDK called despite local file error")
	}
}

func TestUploadSDKFailure(t *testing.T) {
	_, file := tmpClip(t)
	f := &fakeSDK{err: errors.New("boom-network")}
	var hook []string
	s := newSvc(f)
	s.OnUpload = func(p string, ok bool, n int64) { hook = append(hook, fmt.Sprintf("%s %v %d", p, ok, n)) }
	_, err := s.Upload(context.Background(), baseCfg(), file, "clip.mp4", "")
	if status(t, err) != 500 || err.Error() != "S3 upload failed for key streamhub/live/clip.mp4: boom-network" {
		t.Fatalf("%v", err)
	}
	if len(hook) != 1 || hook[0] != "aws false 0" {
		t.Fatalf("metrics %v", hook)
	}
	// API errors surface the service message, never credentials.
	f.err = &smithy.GenericAPIError{Code: "AccessDenied", Message: "Access Denied"}
	_, err = s.Upload(context.Background(), baseCfg(), file, "clip.mp4", "")
	if err.Error() != "S3 upload failed for key streamhub/live/clip.mp4: Access Denied" || strings.Contains(err.Error(), "secret_test") {
		t.Fatalf("%v", err)
	}
}

func TestUploadBuffer(t *testing.T) {
	f := &fakeSDK{etag: strPtr(`"e1"`)}
	s := newSvc(f)
	res, err := s.UploadBuffer(context.Background(), baseCfg(), []byte(`{"a":1}`), "out/r.json", "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Key != "streamhub/live/out/r.json" || res.SizeBytes != 7 || res.ETag != "e1" || *f.puts[0].ContentType != "application/json" || *f.puts[0].ContentLength != 7 {
		t.Fatalf("%+v", res)
	}
	f.err = errors.New("nope")
	_, err = s.UploadBuffer(context.Background(), baseCfg(), []byte("x"), "a.png", "")
	if err.Error() != "S3 uploadBuffer failed for key streamhub/live/a.png: nope" {
		t.Fatalf("%v", err)
	}
}

// ---- config validation ------------------------------------------------------

func TestConfigValidation(t *testing.T) {
	_, file := tmpClip(t)
	cases := []struct {
		cfg  contracts.S3Config
		want string
	}{
		{baseCfg(func(c *contracts.S3Config) { c.Bucket = "" }), "S3 config: bucket is required"},
		{baseCfg(func(c *contracts.S3Config) { c.SecretKey = "" }), "S3 config: credentials unresolved (check secret store / *_env refs)"},
		{baseCfg(func(c *contracts.S3Config) { c.AccessKey = "" }), "S3 config: credentials unresolved (check secret store / *_env refs)"},
	}
	for _, c := range cases {
		f := &fakeSDK{}
		s := newSvc(f)
		ctx := context.Background()
		_, e1 := s.Upload(ctx, c.cfg, file, "k", "")
		_, e2 := s.PresignGet(ctx, c.cfg, "k", 0, nil)
		e3 := s.Delete(ctx, c.cfg, "k")
		_, e4 := s.Exists(ctx, c.cfg, "k")
		_, e5 := s.UploadBuffer(ctx, c.cfg, nil, "k", "")
		for _, err := range []error{e1, e2, e3, e4, e5} {
			if err == nil || err.Error() != c.want || status(t, err) != 500 {
				t.Fatalf("want %q got %v", c.want, err)
			}
		}
		if f.builds != 0 {
			t.Fatal("client built for invalid config")
		}
	}
}

// ---- presignGet -------------------------------------------------------------

func TestPresignTTL(t *testing.T) {
	cases := []struct {
		in   float64
		want int64
	}{
		{1800, 1800},
		{0, 3600}, // "undefined"
		{-5, 3600},
		{math.NaN(), 3600},
		{math.Inf(1), 3600},
		{30 * 24 * 3600, 7 * 24 * 3600},
		{7 * 24 * 3600, 7 * 24 * 3600},
		{100.9, 100},
	}
	for _, c := range cases {
		f := &fakeSDK{}
		url, err := newSvc(f).PresignGet(context.Background(), baseCfg(), "clip.mp4", c.in, nil)
		if err != nil {
			t.Fatal(err)
		}
		if f.expiries[0] != c.want {
			t.Errorf("ttl %v → %d want %d", c.in, f.expiries[0], c.want)
		}
		if !strings.Contains(url, "streamhub/live/clip.mp4") || *f.gets[0].Key != "streamhub/live/clip.mp4" {
			t.Errorf("url %q", url)
		}
	}
}

func TestPresignOptions(t *testing.T) {
	f := &fakeSDK{}
	s := newSvc(f)
	_, _ = s.PresignGet(context.Background(), baseCfg(), "a.mp4", 60, &contracts.S3PresignOptions{
		ResponseContentDisposition: `attachment; filename="a.mp4"`, ResponseContentType: "video/mp4",
	})
	_, _ = s.PresignGet(context.Background(), baseCfg(), "a.mp4", 60, nil)
	g := f.gets
	if *g[0].ResponseContentDisposition != `attachment; filename="a.mp4"` || *g[0].ResponseContentType != "video/mp4" {
		t.Fatalf("%+v", g[0])
	}
	if g[1].ResponseContentDisposition != nil || g[1].ResponseContentType != nil {
		t.Fatal("unset overrides must stay nil")
	}
	f.err = errors.New("sign-fail")
	_, err := s.PresignGet(context.Background(), baseCfg(), "a.mp4", 60, nil)
	if err.Error() != "S3 presignGet failed for key streamhub/live/a.mp4: sign-fail" {
		t.Fatalf("%v", err)
	}
}

// ---- delete / exists ----------------------------------------------------------

func TestDeleteAndExists(t *testing.T) {
	notFound := []error{
		&smithy.GenericAPIError{Code: "NotFound"},
		&smithy.GenericAPIError{Code: "NoSuchKey"},
		statusErr{404},
		fmt.Errorf("wrapped: %w", statusErr{404}),
	}
	ctx := context.Background()
	for _, nf := range notFound {
		f := &fakeSDK{err: nf}
		if err := newSvc(f).Delete(ctx, baseCfg(), "clip.mp4"); err != nil {
			t.Errorf("delete swallow %v: %v", nf, err)
		}
		f = &fakeSDK{err: nf}
		if ok, err := newSvc(f).Exists(ctx, baseCfg(), "clip.mp4"); ok || err != nil {
			t.Errorf("exists %v: %v %v", nf, ok, err)
		}
	}
	f := &fakeSDK{}
	s := newSvc(f)
	if ok, err := s.Exists(ctx, baseCfg(), "clip.mp4"); !ok || err != nil {
		t.Fatalf("exists true: %v %v", ok, err)
	}
	if *f.heads[0].Key != "streamhub/live/clip.mp4" || *f.heads[0].Bucket != "my-bucket" {
		t.Fatalf("%+v", f.heads[0])
	}
	if err := s.Delete(ctx, baseCfg(), "clip.mp4"); err != nil || *f.deletes[0].Key != "streamhub/live/clip.mp4" {
		t.Fatalf("delete ok: %v", err)
	}
	f.err = errors.New("access denied")
	if err := s.Delete(ctx, baseCfg(), "clip.mp4"); err == nil || status(t, err) != 500 || err.Error() != "S3 delete failed for key streamhub/live/clip.mp4: access denied" {
		t.Fatalf("delete rethrow: %v", err)
	}
	f.err = statusErr{403}
	if _, err := s.Exists(ctx, baseCfg(), "clip.mp4"); err == nil || err.Error() != "S3 exists check failed for key streamhub/live/clip.mp4: http 403" {
		t.Fatalf("exists rethrow: %v", err)
	}
}

// ---- publicUrlFor -------------------------------------------------------------

func TestPublicURLFor(t *testing.T) {
	cases := []struct {
		name string
		cfg  contracts.S3Config
		key  string
		want string
	}{
		{"aws virtual-host", baseCfg(), "clip.mp4", "https://my-bucket.s3.us-east-1.amazonaws.com/streamhub/live/clip.mp4"},
		{"minio path-style", baseCfg(func(c *contracts.S3Config) {
			c.Provider, c.Endpoint, c.ForcePathStyle = "minio", "http://minio.local:9000/", true
		}), "clip.mp4", "http://minio.local:9000/my-bucket/streamhub/live/clip.mp4"},
		{"wasabi virtual-host", baseCfg(func(c *contracts.S3Config) {
			c.Provider, c.Endpoint = "wasabi", "https://s3.wasabisys.com"
		}), "clip.mp4", "https://my-bucket.s3.wasabisys.com/streamhub/live/clip.mp4"},
		{"custom endpoint keeps path, drops default port", baseCfg(func(c *contracts.S3Config) {
			c.Endpoint = "HTTPS://S3.Example.com:443/base//"
		}), "a.mp4", "https://my-bucket.s3.example.com/base/streamhub/live/a.mp4"},
		{"custom endpoint keeps explicit port", baseCfg(func(c *contracts.S3Config) {
			c.Endpoint = "http://s3.example.com:9000"
		}), "a.mp4", "http://my-bucket.s3.example.com:9000/streamhub/live/a.mp4"},
		{"unparseable endpoint falls back to path-style", baseCfg(func(c *contracts.S3Config) {
			c.Endpoint = "s3.example.com/"
		}), "a.mp4", "s3.example.com/my-bucket/streamhub/live/a.mp4"},
		{"segments encoded", baseCfg(func(c *contracts.S3Config) { c.Prefix = "" }), "my clip.mp4", "https://my-bucket.s3.us-east-1.amazonaws.com/my%20clip.mp4"},
		{"unicode + reserved, slashes kept", baseCfg(func(c *contracts.S3Config) { c.Prefix = "" }), "dir ñ/a+b?#&(1).mp4", "https://my-bucket.s3.us-east-1.amazonaws.com/dir%20%C3%B1/a%2Bb%3F%23%26(1).mp4"},
	}
	s := newSvc(&fakeSDK{})
	for _, c := range cases {
		if got := s.PublicURLFor(c.cfg, c.key); got != c.want {
			t.Errorf("%s: %q want %q", c.name, got, c.want)
		}
	}
}

// ---- client cache -------------------------------------------------------------

func TestClientCacheAndEvict(t *testing.T) {
	f := &fakeSDK{}
	s := newSvc(f)
	ctx := context.Background()
	a := baseCfg()
	b := baseCfg(func(c *contracts.S3Config) { c.SecretKey = "rotated-secret" })
	_, _ = s.Exists(ctx, a, "k")
	_, _ = s.Exists(ctx, a, "k")
	if f.builds != 1 {
		t.Fatalf("builds %d", f.builds)
	}
	_, _ = s.Exists(ctx, b, "k") // rotated secret (different length) → new client
	if f.builds != 2 {
		t.Fatalf("builds %d", f.builds)
	}
	s.Evict(&a)
	_, _ = s.Exists(ctx, b, "k")
	_, _ = s.Exists(ctx, a, "k")
	if f.builds != 3 {
		t.Fatalf("builds after single evict %d", f.builds)
	}
	s.Evict(nil)
	_, _ = s.Exists(ctx, a, "k")
	_, _ = s.Exists(ctx, b, "k")
	if f.builds != 5 {
		t.Fatalf("builds after evict all %d", f.builds)
	}
	if fp := fingerprint(a); strings.Contains(fp, "secret_test") || fp != "aws|us-east-1||0|AKIA_TEST|11" {
		t.Fatalf("fingerprint %q", fp)
	}
}

// ---- SSRF guard (s3.ssrf.spec.ts) ----------------------------------------------

func ssrfCfg(endpoint string) contracts.S3Config {
	return contracts.S3Config{
		Provider: "minio", Bucket: "vods", Region: "us-east-1", Endpoint: endpoint,
		ForcePathStyle: true, AccessKey: "AKIA-TEST", SecretKey: "shhh",
	}
}

func ssrfSvc(env map[string]string) *Service {
	s := New() // real SDK: presigning is offline
	s.Env = func(k string) string { return env[k] }
	s.Resolve = func(_ context.Context, host string) ([]string, error) {
		switch host {
		case "minio.internal.lan":
			return []string{"10.1.2.3"}, nil
		case "s3.example.com", "minio.example.com":
			return []string{"93.184.216.34"}, nil
		}
		return nil, errors.New("ENOTFOUND " + host)
	}
	return s
}

func TestSSRFPrivateEndpointsRejected(t *testing.T) {
	ctx := context.Background()
	for _, ep := range []string{"http://169.254.169.254", "http://127.0.0.1:9000", "http://192.168.1.50:9000", "http://[fc00::1]:9000", "http://minio.internal.lan:9000"} {
		s := ssrfSvc(nil)
		cfg := ssrfCfg(ep)
		_, e1 := s.PresignGet(ctx, cfg, "k.mp4", 0, nil)
		_, e2 := s.Upload(ctx, cfg, "/tmp/nope.mp4", "k.mp4", "")
		e3 := s.Delete(ctx, cfg, "k.mp4")
		_, e4 := s.Exists(ctx, cfg, "k.mp4")
		_, e5 := s.UploadBuffer(ctx, cfg, []byte("x"), "k.mp4", "")
		for i, err := range []error{e1, e2, e3, e4, e5} {
			if err == nil || status(t, err) != 400 {
				t.Errorf("%s op %d: %v", ep, i, err)
			}
		}
		if len(s.clients) != 0 {
			t.Errorf("%s: client built before the guard", ep)
		}
	}
}

func TestSSRFAcceptedAndEscapeHatch(t *testing.T) {
	ctx := context.Background()
	url, err := ssrfSvc(nil).PresignGet(ctx, ssrfCfg("https://s3.example.com"), "k.mp4", 0, nil)
	if err != nil || !strings.Contains(url, "s3.example.com") {
		t.Fatalf("public endpoint: %q %v", url, err)
	}
	url, err = ssrfSvc(nil).PresignGet(ctx, ssrfCfg(""), "k.mp4", 0, nil)
	if err != nil || !strings.Contains(url, "amazonaws.com") {
		t.Fatalf("no endpoint: %q %v", url, err)
	}
	esc := map[string]string{security.AllowPrivateS3EndpointEnv: "1"}
	url, err = ssrfSvc(esc).PresignGet(ctx, ssrfCfg("http://192.168.1.50:9000"), "k.mp4", 0, nil)
	if err != nil || !strings.Contains(url, "192.168.1.50") {
		t.Fatalf("escape hatch: %q %v", url, err)
	}
	_, err = ssrfSvc(esc).PresignGet(ctx, ssrfCfg("gopher://192.168.1.50:9000"), "k.mp4", 0, nil)
	if err == nil || status(t, err) != 400 {
		t.Fatalf("gopher admitted: %v", err)
	}
}

// ---- real SDK wiring (offline presign) ------------------------------------------

func TestDefaultFactoryPresign(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name   string
		cfg    contracts.S3Config
		ttl    float64
		prefix string // expected URL up to the query
		exp    string
	}{
		{"aws virtual-host", baseCfg(), 1800,
			"https://my-bucket.s3.us-east-1.amazonaws.com/streamhub/live/clip.mp4?", "X-Amz-Expires=1800"},
		{"aws region default", baseCfg(func(c *contracts.S3Config) { c.Region = "" }), 0,
			"https://my-bucket.s3.us-east-1.amazonaws.com/streamhub/live/clip.mp4?", "X-Amz-Expires=3600"},
		{"minio path-style", baseCfg(func(c *contracts.S3Config) {
			c.Provider, c.Endpoint, c.ForcePathStyle = "minio", "http://minio.example.com:9000", true
		}), 30 * 24 * 3600, "http://minio.example.com:9000/my-bucket/streamhub/live/clip.mp4?", "X-Amz-Expires=604800"},
		{"wasabi virtual-host", baseCfg(func(c *contracts.S3Config) {
			c.Provider, c.Endpoint, c.Region = "wasabi", "https://s3.example.com", "eu-central-1"
		}), 60, "https://my-bucket.s3.example.com/streamhub/live/clip.mp4?", "X-Amz-Expires=60"},
	}
	for _, c := range cases {
		url, err := ssrfSvc(nil).PresignGet(ctx, c.cfg, "clip.mp4", c.ttl, &contracts.S3PresignOptions{ResponseContentType: "video/mp4"})
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if !strings.HasPrefix(url, c.prefix) || !strings.Contains(url, c.exp) ||
			!strings.Contains(url, "X-Amz-Credential=AKIA_TEST") || !strings.Contains(url, "response-content-type=video%2Fmp4") {
			t.Errorf("%s: %s", c.name, url)
		}
		if strings.Contains(url, "secret_test") {
			t.Errorf("%s: secret leaked", c.name)
		}
	}
}

func strPtr(s string) *string { return &s }
