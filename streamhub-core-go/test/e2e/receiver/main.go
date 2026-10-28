// Command receiver is the webhook receiver of the e2e run (was
// remote/receiver.py): it records every POST (path, X-StreamHub-* headers and
// the JSON body) as one line of <out.jsonl>, with whether
// X-StreamHub-Signature verifies (sha256=HMAC-SHA256(CB_SECRET, body)).
//
//	CB_SECRET=… receiver <port> <out.jsonl>     (listens on 127.0.0.1)
//
// run.sh cross-builds it next to the core and up.sh starts it.
package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sync"
	"time"
)

// record is one receiver.jsonl line (the keys the e2e scenarios read with jq).
type record struct {
	TS       float64         `json:"ts"`
	Path     string          `json:"path"`
	Event    *string         `json:"event"`
	Delivery *string         `json:"delivery"`
	SigValid bool            `json:"sigValid"`
	HasSig   bool            `json:"hasSig"`
	Body     json.RawMessage `json:"body"`
}

func header(r *http.Request, name string) *string {
	if v := r.Header.Values(name); len(v) > 0 {
		return &v[0]
	}
	return nil
}

// handler records each POST into outPath. The file is opened per record (as
// the Python receiver did): up.sh deletes it after the readiness ping, and
// later records must land in a fresh file.
func handler(secret []byte, outPath string, now func() time.Time) http.Handler {
	var mu sync.Mutex
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "unsupported method", http.StatusNotImplemented)
			return
		}
		body, _ := io.ReadAll(r.Body)
		sig := r.Header.Get("X-StreamHub-Signature")
		mac := hmac.New(sha256.New, secret)
		mac.Write(body)
		want := "sha256=" + hex.EncodeToString(mac.Sum(nil))
		rec := record{
			TS:       float64(now().UnixNano()) / 1e9,
			Path:     r.URL.RequestURI(),
			Event:    header(r, "X-StreamHub-Event"),
			Delivery: header(r, "X-StreamHub-Delivery"),
			SigValid: hmac.Equal([]byte(sig), []byte(want)),
			HasSig:   sig != "",
			Body:     json.RawMessage("null"),
		}
		var compact bytes.Buffer
		if json.Compact(&compact, body) == nil {
			rec.Body = compact.Bytes()
		}
		line, _ := json.Marshal(rec)
		mu.Lock()
		err := appendLine(outPath, line)
		mu.Unlock()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "ok")
	})
}

func appendLine(path string, line []byte) error {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	_, err = f.Write(append(line, '\n'))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: CB_SECRET=… receiver <port> <out.jsonl>")
		os.Exit(2)
	}
	secret, ok := os.LookupEnv("CB_SECRET")
	if !ok {
		fmt.Fprintln(os.Stderr, "receiver: CB_SECRET is not set")
		os.Exit(2)
	}
	srv := &http.Server{
		Addr:              net.JoinHostPort("127.0.0.1", os.Args[1]),
		Handler:           handler([]byte(secret), os.Args[2], time.Now),
		ReadHeaderTimeout: 10 * time.Second,
	}
	fmt.Fprintln(os.Stderr, "receiver:", srv.ListenAndServe())
	os.Exit(1)
}
