package s3

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/security"
)

// A4: a custom S3 endpoint is dialed through the egress guard — the
// save/upload-time assertSafeEndpoint only checked the name once. An
// in-process loopback server stands in for a rebinding target; with
// STREAMHUB_ALLOW_PRIVATE_S3_ENDPOINT the operator opt-out still reaches it.
func TestDefaultClientCustomEndpointDialIsGuarded(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer srv.Close()
	cfg := contracts.S3Config{Bucket: "b", Endpoint: srv.URL, ForcePathStyle: true, AccessKey: "k", SecretKey: "s"}
	head := func() error {
		c, _ := DefaultClientFactory(cfg)
		_, err := c.HeadObject(context.Background(), &awss3.HeadObjectInput{Bucket: aws.String("b"), Key: aws.String("k")},
			func(o *awss3.Options) { o.RetryMaxAttempts = 1 })
		return err
	}
	t.Setenv(security.AllowPrivateS3EndpointEnv, "")
	if err := head(); err == nil || !strings.Contains(err.Error(), "blocked") {
		t.Fatalf("want an egress block, got %v", err)
	}
	if hits.Load() != 0 {
		t.Fatalf("the private endpoint was reached (%d hits)", hits.Load())
	}
	t.Setenv(security.AllowPrivateS3EndpointEnv, "1")
	_ = head()
	if hits.Load() == 0 {
		t.Fatal("the opt-out env no longer reaches a private endpoint")
	}
}
