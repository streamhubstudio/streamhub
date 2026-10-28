package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReceiverRecords(t *testing.T) {
	out := filepath.Join(t.TempDir(), "receiver.jsonl")
	secret := []byte("e2e-callback-secret")
	srv := httptest.NewServer(handler(secret, out, func() time.Time { return time.Unix(1700000000, 500_000_000) }))
	defer srv.Close()

	post := func(path, body string, hdr map[string]string) *http.Response {
		req, _ := http.NewRequest(http.MethodPost, srv.URL+path, strings.NewReader(body))
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res
	}
	// Readiness ping, then deleted — like up.sh does.
	if res := post("/ping", "", nil); res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	if err := os.Remove(out); err != nil {
		t.Fatal(err)
	}

	body := "{\n  \"event\": \"stream.started\", \"app\": \"live\", \"id\": \"s1\"\n}"
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(body))
	good := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	post("/cb?x=1", body, map[string]string{"X-StreamHub-Signature": good, "X-StreamHub-Event": "stream.started", "X-StreamHub-Delivery": "d-1"})
	post("/cb", "not json", map[string]string{"X-StreamHub-Signature": "sha256=bad"})
	if res, _ := http.Get(srv.URL + "/cb"); res.StatusCode != http.StatusNotImplemented {
		t.Fatal("GET should be 501, got", res.StatusCode)
	}

	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("want 2 records after the ping was dropped, got %d: %s", len(lines), raw)
	}
	var a, b map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(lines[1]), &b); err != nil {
		t.Fatal(err)
	}
	if a["ts"] != 1700000000.5 || a["path"] != "/cb?x=1" || a["event"] != "stream.started" || a["delivery"] != "d-1" ||
		a["sigValid"] != true || a["hasSig"] != true {
		t.Fatalf("record a: %v", a)
	}
	if bd, _ := a["body"].(map[string]any); bd["event"] != "stream.started" || bd["app"] != "live" || bd["id"] != "s1" {
		t.Fatalf("body a: %v", a["body"])
	}
	if b["event"] != nil || b["delivery"] != nil || b["sigValid"] != false || b["hasSig"] != true || b["body"] != nil {
		t.Fatalf("record b: %v", b)
	}
	if _, ok := b["body"]; !ok {
		t.Fatal("body key must be present (null)")
	}
}
