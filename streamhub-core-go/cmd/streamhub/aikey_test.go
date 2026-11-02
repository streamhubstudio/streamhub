package main

import (
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/s3"
)

// The AI key resolver reads env for STREAMFLOW_AI_API_KEY only (the secrets
// store itself never does since 3.3.3).
func TestAIKeyResolverFixedEnv(t *testing.T) {
	t.Setenv(aiKeyRef, "env-ai-key")
	t.Setenv("STREAMHUB_JWT_SECRET", "jwt")
	store := s3.NewSecretsStore(t.TempDir())
	r := aiKeyResolver{store}
	if v, ok := r.Get(aiKeyRef); !ok || v != "env-ai-key" {
		t.Errorf("fixed ref env fallback = %q,%v", v, ok)
	}
	if v, ok := r.Get("STREAMHUB_JWT_SECRET"); ok || v != "" {
		t.Errorf("INVARIANT: any other ref must not read env (%q)", v)
	}
	if err := store.Set(aiKeyRef, "stored-ai-key"); err != nil {
		t.Fatal(err)
	}
	if v, _ := r.Get(aiKeyRef); v != "stored-ai-key" {
		t.Errorf("secrets.json wins: %q", v)
	}
}
