// Command hlsrecv is an e2e test helper: a minimal HTTP server that accepts
// HLS push (PUT/POST/DELETE) into a directory and serves it back with GET.
package main

import (
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	listen := flag.String("listen", ":8088", "listen address")
	dir := flag.String("dir", "/tmp/hls", "storage directory")
	flag.Parse()
	_ = os.MkdirAll(*dir, 0o755)
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		clean := filepath.Clean("/" + r.URL.Path)
		if strings.Contains(clean, "..") {
			http.Error(w, "bad path", 400)
			return
		}
		p := filepath.Join(*dir, clean)
		switch r.Method {
		case http.MethodPut, http.MethodPost:
			_ = os.MkdirAll(filepath.Dir(p), 0o755)
			tmp := p + ".part"
			f, err := os.Create(tmp)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			n, err := io.Copy(f, r.Body)
			f.Close()
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			_ = os.Rename(tmp, p)
			log.Printf("%s %s %d bytes", r.Method, clean, n)
			w.WriteHeader(http.StatusCreated)
		case http.MethodDelete:
			_ = os.Remove(p)
			w.WriteHeader(http.StatusNoContent)
		default:
			http.ServeFile(w, r, p)
		}
	})
	log.Fatal(http.ListenAndServe(*listen, nil))
}
