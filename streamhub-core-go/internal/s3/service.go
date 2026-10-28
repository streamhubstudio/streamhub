// Package s3 is the port of modules/s3: the multi-provider S3 abstraction
// (AWS / Wasabi / MinIO) and the secrets.json store. No routes.
package s3

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"os"
	"path"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/credentials"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
)

const (
	// DefaultPresignTTL is the presigned-GET lifetime (s) when unspecified.
	DefaultPresignTTL = 3600
	// MaxPresignTTL is the SigV4 maximum (7 days).
	MaxPresignTTL = 7 * 24 * 3600
)

// Client is the subset of the S3 API the service uses.
type Client interface {
	PutObject(ctx context.Context, in *awss3.PutObjectInput, optFns ...func(*awss3.Options)) (*awss3.PutObjectOutput, error)
	HeadObject(ctx context.Context, in *awss3.HeadObjectInput, optFns ...func(*awss3.Options)) (*awss3.HeadObjectOutput, error)
	DeleteObject(ctx context.Context, in *awss3.DeleteObjectInput, optFns ...func(*awss3.Options)) (*awss3.DeleteObjectOutput, error)
}

// Presigner signs GET URLs offline.
type Presigner interface {
	PresignGetObject(ctx context.Context, in *awss3.GetObjectInput, optFns ...func(*awss3.PresignOptions)) (*v4.PresignedHTTPRequest, error)
}

// ClientFactory builds the SDK pair for one resolved config.
type ClientFactory func(cfg contracts.S3Config) (Client, Presigner)

type clientPair struct {
	client    Client
	presigner Presigner
}

// Service is the S3Service port.
type Service struct {
	// NewClient builds SDK clients (tests inject fakes).
	NewClient ClientFactory
	// Resolve is the DNS seam of the endpoint SSRF guard.
	Resolve security.HostResolver
	// Env reads STREAMHUB_ALLOW_PRIVATE_S3_ENDPOINT (per call, like Node).
	Env func(string) string
	// OnUpload is the optional metrics hook (nil-safe).
	OnUpload func(provider string, ok bool, size int64)

	mu      sync.Mutex
	clients map[string]clientPair
}

var _ contracts.S3Service = (*Service)(nil)

// New builds the service with the real SDK factory.
func New() *Service {
	return &Service{
		NewClient: DefaultClientFactory,
		Resolve:   security.DefaultHostResolver,
		Env:       os.Getenv,
		clients:   map[string]clientPair{},
	}
}

// DefaultClientFactory builds aws-sdk-go-v2 clients: region default
// us-east-1, custom endpoint → BaseEndpoint, path style from forcePathStyle.
func DefaultClientFactory(cfg contracts.S3Config) (Client, Presigner) {
	region := cfg.Region
	if region == "" {
		region = "us-east-1"
	}
	opts := awss3.Options{
		Region:       region,
		UsePathStyle: cfg.ForcePathStyle,
		Credentials:  credentials.NewStaticCredentialsProvider(cfg.AccessKey, cfg.SecretKey, ""),
	}
	if ep := strings.TrimSpace(cfg.Endpoint); ep != "" {
		opts.BaseEndpoint = aws.String(ep)
	}
	c := awss3.New(opts)
	return c, awss3.NewPresignClient(c)
}

// Upload streams a local file to key (prefixed) with ContentLength set.
func (s *Service) Upload(ctx context.Context, cfg contracts.S3Config, localPath, key, contentType string) (*contracts.S3UploadResult, error) {
	if err := s.preflight(ctx, cfg); err != nil {
		return nil, err
	}
	objectKey := resolveKey(cfg, key)

	st, err := os.Stat(localPath)
	if err != nil {
		return nil, wrap(nodeFSError(err, "stat", localPath), "S3 upload: cannot read local file "+localPath)
	}
	if !st.Mode().IsRegular() {
		return nil, wrap(errors.New("S3 upload source is not a file: "+localPath), "S3 upload: cannot read local file "+localPath)
	}
	size := st.Size()

	f, err := os.Open(localPath)
	if err != nil {
		s.onUpload(cfg.Provider, false, 0)
		return nil, wrap(nodeFSError(err, "open", localPath), "S3 upload failed for key "+objectKey)
	}
	defer f.Close()
	return s.put(ctx, cfg, key, objectKey, f, size, contentType, "S3 upload failed for key ")
}

// UploadBuffer uploads an in-memory body (Node uploadBuffer).
func (s *Service) UploadBuffer(ctx context.Context, cfg contracts.S3Config, body []byte, key, contentType string) (*contracts.S3UploadResult, error) {
	if err := s.preflight(ctx, cfg); err != nil {
		return nil, err
	}
	objectKey := resolveKey(cfg, key)
	return s.put(ctx, cfg, key, objectKey, bytes.NewReader(body), int64(len(body)), contentType, "S3 uploadBuffer failed for key ")
}

func (s *Service) put(ctx context.Context, cfg contracts.S3Config, key, objectKey string, body io.Reader, size int64, contentType, failMsg string) (*contracts.S3UploadResult, error) {
	if contentType == "" {
		contentType = guessContentType(objectKey)
	}
	out, err := s.clientFor(cfg).client.PutObject(ctx, &awss3.PutObjectInput{
		Bucket:        aws.String(cfg.Bucket),
		Key:           aws.String(objectKey),
		Body:          body,
		ContentLength: aws.Int64(size),
		ContentType:   aws.String(contentType),
	})
	if err != nil {
		s.onUpload(cfg.Provider, false, 0)
		return nil, wrap(err, failMsg+objectKey)
	}
	s.onUpload(cfg.Provider, true, size)
	res := &contracts.S3UploadResult{
		Key:       objectKey,
		Bucket:    cfg.Bucket,
		URL:       PublicURLFor(cfg, key),
		SizeBytes: size,
	}
	if out != nil && out.ETag != nil {
		res.ETag = strings.ReplaceAll(*out.ETag, `"`, "")
	}
	return res, nil
}

// PresignGet returns a presigned GET URL (ttl default 1h, max 7d).
func (s *Service) PresignGet(ctx context.Context, cfg contracts.S3Config, key string, expiresInSeconds float64, opts *contracts.S3PresignOptions) (string, error) {
	if err := s.preflight(ctx, cfg); err != nil {
		return "", err
	}
	objectKey := resolveKey(cfg, key)
	ttl := ClampTTL(expiresInSeconds)
	in := &awss3.GetObjectInput{Bucket: aws.String(cfg.Bucket), Key: aws.String(objectKey)}
	if opts != nil {
		if opts.ResponseContentDisposition != "" {
			in.ResponseContentDisposition = aws.String(opts.ResponseContentDisposition)
		}
		if opts.ResponseContentType != "" {
			in.ResponseContentType = aws.String(opts.ResponseContentType)
		}
	}
	req, err := s.clientFor(cfg).presigner.PresignGetObject(ctx, in, awss3.WithPresignExpires(time.Duration(ttl)*time.Second))
	if err != nil {
		return "", wrap(err, "S3 presignGet failed for key "+objectKey)
	}
	return req.URL, nil
}

// Delete removes an object; not-found is a no-op.
func (s *Service) Delete(ctx context.Context, cfg contracts.S3Config, key string) error {
	if err := s.preflight(ctx, cfg); err != nil {
		return err
	}
	objectKey := resolveKey(cfg, key)
	_, err := s.clientFor(cfg).client.DeleteObject(ctx, &awss3.DeleteObjectInput{Bucket: aws.String(cfg.Bucket), Key: aws.String(objectKey)})
	if err != nil && !isNotFound(err) {
		return wrap(err, "S3 delete failed for key "+objectKey)
	}
	return nil
}

// Exists HEADs the object; not-found → false.
func (s *Service) Exists(ctx context.Context, cfg contracts.S3Config, key string) (bool, error) {
	if err := s.preflight(ctx, cfg); err != nil {
		return false, err
	}
	objectKey := resolveKey(cfg, key)
	_, err := s.clientFor(cfg).client.HeadObject(ctx, &awss3.HeadObjectInput{Bucket: aws.String(cfg.Bucket), Key: aws.String(objectKey)})
	if err != nil {
		if isNotFound(err) {
			return false, nil
		}
		return false, wrap(err, "S3 exists check failed for key "+objectKey)
	}
	return true, nil
}

// PublicURLFor is the service method form of the package func.
func (s *Service) PublicURLFor(cfg contracts.S3Config, key string) string {
	return PublicURLFor(cfg, key)
}

// PublicURLFor is the canonical (non-presigned) object URL.
func PublicURLFor(cfg contracts.S3Config, key string) string {
	segs := strings.Split(resolveKey(cfg, key), "/")
	for i, seg := range segs {
		segs[i] = jsx.EncodeURIComponent(seg)
	}
	encoded := strings.Join(segs, "/")

	if cfg.Endpoint != "" {
		base := strings.TrimRight(cfg.Endpoint, "/")
		if cfg.ForcePathStyle {
			return base + "/" + cfg.Bucket + "/" + encoded
		}
		if proto, host, pathname, ok := whatwgParts(base); ok {
			return proto + "//" + cfg.Bucket + "." + host + strings.TrimRight(pathname, "/") + "/" + encoded
		}
		return base + "/" + cfg.Bucket + "/" + encoded
	}
	return "https://" + cfg.Bucket + ".s3." + cfg.Region + ".amazonaws.com/" + encoded
}

// whatwgParts approximates new URL(raw).{protocol,host,pathname}; ok=false
// where the WHATWG parser throws (no scheme).
func whatwgParts(raw string) (proto, host, pathname string, ok bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" {
		return "", "", "", false
	}
	scheme := strings.ToLower(u.Scheme)
	proto = scheme + ":"
	if u.Opaque != "" { // e.g. "localhost:9000" → protocol "localhost:", path "9000"
		return proto, "", u.Opaque, true
	}
	special := map[string]string{"http": "80", "https": "443", "ws": "80", "wss": "443", "ftp": "21", "file": ""}
	defPort, isSpecial := special[scheme]
	host = u.Host
	pathname = u.EscapedPath()
	if isSpecial {
		h, p := strings.ToLower(u.Hostname()), u.Port()
		if strings.Contains(h, ":") {
			h = "[" + h + "]"
		}
		if p != "" && p != defPort {
			h += ":" + p
		}
		host = h
		if pathname == "" {
			pathname = "/"
		}
	}
	return proto, host, pathname, true
}

// Evict drops the cached client of cfg, or all clients when cfg is nil.
func (s *Service) Evict(cfg *contracts.S3Config) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cfg != nil {
		delete(s.clients, fingerprint(*cfg))
		return
	}
	s.clients = map[string]clientPair{}
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

func (s *Service) preflight(ctx context.Context, cfg contracts.S3Config) error {
	if err := assertConfig(cfg); err != nil {
		return err
	}
	return s.assertSafeEndpoint(ctx, cfg)
}

func (s *Service) clientFor(cfg contracts.S3Config) clientPair {
	fp := fingerprint(cfg)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.clients == nil {
		s.clients = map[string]clientPair{}
	}
	if p, ok := s.clients[fp]; ok {
		return p
	}
	factory := s.NewClient
	if factory == nil {
		factory = DefaultClientFactory
	}
	c, p := factory(cfg)
	pair := clientPair{client: c, presigner: p}
	s.clients[fp] = pair
	return pair
}

func (s *Service) onUpload(provider string, ok bool, size int64) {
	if s.OnUpload != nil {
		s.OnUpload(provider, ok, size)
	}
}

// fingerprint is the client cache key: credentials mixed in (secret by
// length only), never logged.
func fingerprint(cfg contracts.S3Config) string {
	fp := "0"
	if cfg.ForcePathStyle {
		fp = "1"
	}
	return strings.Join([]string{
		cfg.Provider, cfg.Region, cfg.Endpoint, fp, cfg.AccessKey,
		fmt.Sprint(jsx.UTF16Len(cfg.SecretKey)),
	}, "|")
}

// resolveKey prepends the prefix unless the key already carries it.
func resolveKey(cfg contracts.S3Config, key string) string {
	clean := strings.TrimLeft(key, "/")
	prefix := strings.Trim(cfg.Prefix, "/")
	if prefix == "" {
		return clean
	}
	if clean == prefix || strings.HasPrefix(clean, prefix+"/") {
		return clean
	}
	return prefix + "/" + clean
}

// ClampTTL: non-positive / non-finite → 3600, else floor capped at 7d.
func ClampTTL(ttl float64) int64 {
	if math.IsNaN(ttl) || math.IsInf(ttl, 0) || ttl <= 0 {
		return DefaultPresignTTL
	}
	return int64(math.Min(math.Floor(ttl), MaxPresignTTL))
}

var contentTypes = map[string]string{
	".mp4":  "video/mp4",
	".webm": "video/webm",
	".mkv":  "video/x-matroska",
	".mov":  "video/quicktime",
	".ts":   "video/mp2t",
	".m3u8": "application/vnd.apple.mpegurl",
	".mp3":  "audio/mpeg",
	".aac":  "audio/aac",
	".ogg":  "audio/ogg",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".png":  "image/png",
	".webp": "image/webp",
	".gif":  "image/gif",
	".json": "application/json",
}

// guessContentType maps the extension (path.extname semantics); default
// application/octet-stream.
func guessContentType(key string) string {
	if ct, ok := contentTypes[strings.ToLower(extname(key))]; ok {
		return ct
	}
	return "application/octet-stream"
}

// extname is Node path.extname: a leading-dot basename has no extension.
func extname(p string) string {
	base := path.Base(strings.TrimRight(p, "/"))
	i := strings.LastIndexByte(base, '.')
	if i <= 0 {
		return ""
	}
	if i == len(base)-1 && strings.Trim(base, ".") == "" {
		return "" // "..": no extension
	}
	return base[i:]
}

// assertSafeEndpoint is the SSRF guard on a custom endpoint; no-op for AWS.
// STREAMHUB_ALLOW_PRIVATE_S3_ENDPOINT skips the private check only.
func (s *Service) assertSafeEndpoint(ctx context.Context, cfg contracts.S3Config) error {
	ep := strings.TrimSpace(cfg.Endpoint)
	if ep == "" {
		return nil
	}
	env := s.Env
	if env == nil {
		env = os.Getenv
	}
	resolve := s.Resolve
	if resolve == nil {
		resolve = security.DefaultHostResolver
	}
	return security.AssertSafeEgressURL(ctx, ep, security.EgressOptions{
		AllowedSchemes: security.HTTPSchemes,
		Label:          "S3 endpoint",
		AllowPrivate:   security.EnvFlag(env(security.AllowPrivateS3EndpointEnv)),
		Resolve:        resolve,
	})
}

func assertConfig(cfg contracts.S3Config) error {
	if cfg.Bucket == "" {
		return httpx.Internal("S3 config: bucket is required")
	}
	if cfg.AccessKey == "" || cfg.SecretKey == "" {
		return httpx.Internal("S3 config: credentials unresolved (check secret store / *_env refs)")
	}
	return nil
}

// isNotFound recognises 404 / NotFound / NoSuchKey across providers.
func isNotFound(err error) bool {
	var hs interface{ HTTPStatusCode() int }
	if errors.As(err, &hs) && hs.HTTPStatusCode() == 404 {
		return true
	}
	var api smithy.APIError
	if errors.As(err, &api) {
		code := api.ErrorCode()
		return code == "NotFound" || code == "NoSuchKey"
	}
	return false
}

// wrap is the controlled 500 "<message>: <reason>". For SDK API errors the
// reason is the service message (as the JS SDK's err.message).
func wrap(err error, message string) error {
	reason := err.Error()
	var api smithy.APIError
	if errors.As(err, &api) {
		if m := api.ErrorMessage(); m != "" {
			reason = m
		} else if c := api.ErrorCode(); c != "" {
			reason = c
		}
	}
	return httpx.Internal(message + ": " + reason)
}

// nodeFSError rewrites common errno failures as Node's fs messages
// ("ENOENT: no such file or directory, stat '<path>'").
func nodeFSError(err error, syscallName, p string) error {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return err
	}
	names := map[syscall.Errno][2]string{
		syscall.ENOENT:       {"ENOENT", "no such file or directory"},
		syscall.EACCES:       {"EACCES", "permission denied"},
		syscall.ENOTDIR:      {"ENOTDIR", "not a directory"},
		syscall.ELOOP:        {"ELOOP", "too many symbolic links encountered"},
		syscall.ENAMETOOLONG: {"ENAMETOOLONG", "name too long"},
		syscall.EPERM:        {"EPERM", "operation not permitted"},
	}
	n, ok := names[errno]
	if !ok {
		return err
	}
	return fmt.Errorf("%s: %s, %s '%s'", n[0], n[1], syscallName, p)
}
