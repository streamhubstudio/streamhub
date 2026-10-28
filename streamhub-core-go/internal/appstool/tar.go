// Package appstool is the decoupled-apps tooling (formerly scripts/apps-*.mjs
// + scripts/lib/{tar,appcompose}.mjs): `streamhub-core apps pack|pull|bump`.
//
// The package format is in https://streamhub.studio/docs/development/PACKAGE-FORMAT. The
// contract that matters is the CONTENT hash — the sha256 of the UNCOMPRESSED
// tar — which apps.lock.json pins: the tar written here is byte-identical to
// the one the Node tar.mjs wrote (locked by testdata vectors), so every pin
// made by the old tooling or an app repo's ci/pack.mjs stays valid. The gzip
// wrapper is transport only (its bytes differ from zlib's; nobody pins them).
package appstool

import (
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Entry is one regular file of a package (Mode 0 = 0644).
type Entry struct {
	Name string
	Body []byte
	Mode int64
}

// splitName fits a path into USTAR name (≤100 bytes) + prefix (≤155 bytes),
// splitting at the first '/' that makes both fit — tar.mjs splitName.
func splitName(full string) (name, prefix string, err error) {
	if len(full) <= 100 {
		return full, "", nil
	}
	parts := strings.Split(full, "/")
	for i := 0; i < len(parts)-1; i++ {
		p := strings.Join(parts[:i+1], "/")
		n := strings.Join(parts[i+1:], "/")
		if len(n) <= 100 && len(p) <= 155 {
			return n, p, nil
		}
	}
	return "", "", fmt.Errorf("path too long for tar: %s", full)
}

// writeOctal is tar.mjs writeOctal: zero-padded octal in len-1 bytes + NUL
// (a value wider than the field is truncated to its first len-1 digits, as
// Buffer.write does).
func writeOctal(h []byte, off, n int, v int64) {
	s := strconv.FormatInt(v, 8)
	if len(s) < n-1 {
		s = strings.Repeat("0", n-1-len(s)) + s
	}
	copy(h[off:off+n-1], s)
	h[off+n-1] = 0
}

func header(e Entry) ([]byte, error) {
	h := make([]byte, 512)
	name, prefix, err := splitName(e.Name)
	if err != nil {
		return nil, err
	}
	copy(h[0:100], name)
	mode := e.Mode
	if mode == 0 {
		mode = 0o644
	}
	writeOctal(h, 100, 8, mode)
	writeOctal(h, 108, 8, 0) // uid
	writeOctal(h, 116, 8, 0) // gid
	writeOctal(h, 124, 12, int64(len(e.Body)))
	writeOctal(h, 136, 12, 0) // mtime — fixed for determinism
	for i := 148; i < 156; i++ {
		h[i] = ' ' // checksum placeholder
	}
	h[156] = '0' // regular file
	copy(h[257:263], "ustar\x00")
	copy(h[263:265], "00")
	if prefix != "" {
		copy(h[345:500], prefix)
	}
	sum := 0
	for _, b := range h {
		sum += int(b)
	}
	cs := strconv.FormatInt(int64(sum), 8)
	if len(cs) < 6 {
		cs = strings.Repeat("0", 6-len(cs)) + cs
	}
	copy(h[148:154], cs)
	h[154] = 0
	h[155] = ' '
	return h, nil
}

// PackTar writes the deterministic USTAR stream (mtime/uid/gid 0, entries in
// the given order, two zero blocks at the end) — the bytes the lock hashes.
func PackTar(entries []Entry) ([]byte, error) {
	var buf bytes.Buffer
	for _, e := range entries {
		h, err := header(e)
		if err != nil {
			return nil, err
		}
		buf.Write(h)
		buf.Write(e.Body)
		if rem := len(e.Body) % 512; rem != 0 {
			buf.Write(make([]byte, 512-rem))
		}
	}
	buf.Write(make([]byte, 1024))
	return buf.Bytes(), nil
}

// Gzip wraps a tar (best compression; transport only).
func Gzip(tar []byte) []byte {
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	_, _ = zw.Write(tar)
	_ = zw.Close()
	return buf.Bytes()
}

// Gunzip inflates a .tar.gz.
func Gunzip(gz []byte) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	return io.ReadAll(zr)
}

// readField is tar.mjs readField: up to the first NUL, trimmed.
func readField(b []byte, off, n int) string {
	s := b[off : off+n]
	if i := bytes.IndexByte(s, 0); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(string(s))
}

// UnpackTar parses a USTAR stream into its regular-file entries (tar.mjs
// unpackTarGz semantics: stops at the zero block or a truncated entry).
func UnpackTar(tar []byte) []Entry {
	var out []Entry
	off := 0
	for off+512 <= len(tar) {
		h := tar[off : off+512]
		if bytes.Count(h, []byte{0}) == 512 {
			break
		}
		name := readField(h, 0, 100)
		prefix := readField(h, 345, 155)
		sizeStr := readField(h, 124, 12)
		size := int64(0)
		if sizeStr != "" {
			v, err := strconv.ParseInt(sizeStr, 8, 64)
			if err != nil {
				break
			}
			size = v
		}
		typ := h[156]
		off += 512
		if size < 0 || int64(off)+size > int64(len(tar)) {
			break
		}
		full := name
		if prefix != "" {
			full = prefix + "/" + name
		}
		if (typ == '0' || typ == 0) && name != "" {
			mode, _ := strconv.ParseInt(readField(h, 100, 8), 8, 64)
			body := make([]byte, size)
			copy(body, tar[off:int64(off)+size])
			out = append(out, Entry{Name: full, Body: body, Mode: mode})
		}
		off += int((size + 511) / 512 * 512)
	}
	return out
}

// ExtractTar writes the entries under dest, refusing any path that escapes it.
func ExtractTar(tar []byte, dest string) (int, error) {
	root, err := filepath.Abs(dest)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return 0, err
	}
	n := 0
	for _, e := range UnpackTar(tar) {
		target := filepath.Join(root, filepath.FromSlash(e.Name))
		if target != root && !strings.HasPrefix(target, root+string(filepath.Separator)) {
			return n, errors.New("unsafe path in bundle: " + e.Name)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return n, err
		}
		if err := os.WriteFile(target, e.Body, 0o644); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}
