package plugins

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Port of appstore/tar.util.ts (the USTAR reader/extractor for the subset
// the writer emits) and appstore/spawn-redirect.util.ts.

func readTarField(block []byte, off, length int) string {
	s := block[off : off+length]
	if i := bytes.IndexByte(s, 0); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(string(s))
}

// UnpackTarGz parses a gzipped USTAR archive into its regular files. Never
// fails: garbage yields nil; parsing stops at the first zero block.
func UnpackTarGz(gz []byte) []TarEntry {
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		return nil
	}
	tar, err := io.ReadAll(zr)
	if err != nil {
		return nil
	}
	var out []TarEntry
	for off := 0; off+512 <= len(tar); {
		header := tar[off : off+512]
		if bytes.Count(header, []byte{0}) == 512 {
			break
		}
		name := readTarField(header, 0, 100)
		prefix := readTarField(header, 345, 155)
		size := int64(0)
		if s := readTarField(header, 124, 12); s != "" {
			n, err := parseOctalPrefix(s)
			if err != nil {
				break
			}
			size = n
		}
		typeflag := header[156]
		off += 512
		if size < 0 || int64(off)+size > int64(len(tar)) {
			break
		}
		full := name
		if prefix != "" {
			full = prefix + "/" + name
		}
		if (typeflag == '0' || typeflag == 0) && name != "" {
			out = append(out, TarEntry{Name: full, Body: append([]byte(nil), tar[off:off+int(size)]...)})
		}
		off += int((size + 511) / 512 * 512)
	}
	return out
}

// parseOctalPrefix is parseInt(s, 8): the leading octal digits.
func parseOctalPrefix(s string) (int64, error) {
	end := 0
	for end < len(s) && s[end] >= '0' && s[end] <= '7' {
		end++
	}
	if end == 0 {
		return 0, fmt.Errorf("not octal")
	}
	return strconv.ParseInt(s[:end], 8, 64)
}

// ExtractTarGz writes the archive's files under destDir, refusing any path
// that escapes it.
func ExtractTarGz(gz []byte, destDir string) (int, error) {
	root, err := filepath.Abs(destDir)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(root, 0o777); err != nil {
		return 0, err
	}
	written := 0
	for _, e := range UnpackTarGz(gz) {
		target := filepath.Join(root, e.Name)
		if filepath.IsAbs(e.Name) {
			target = filepath.Clean(e.Name)
		}
		if target != root && !strings.HasPrefix(target, root+string(filepath.Separator)) {
			return written, fmt.Errorf("unsafe path in bundle: %s", e.Name)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
			return written, err
		}
		if err := os.WriteFile(target, e.Body, 0o644); err != nil {
			return written, err
		}
		written++
	}
	return written, nil
}

// ListTarGzPaths is the archive's file paths.
func ListTarGzPaths(gz []byte) []string {
	var out []string
	for _, e := range UnpackTarGz(gz) {
		out = append(out, e.Name)
	}
	return out
}

func swapDir(value, from, to string) string {
	if value == from {
		return to
	}
	if strings.HasPrefix(value, from+string(filepath.Separator)) {
		return to + value[len(from):]
	}
	return value
}

// RedirectWorkerDir rewrites every fromDir prefix in cwd/args/env to toDir
// (cwd defaults to toDir).
func RedirectWorkerDir(spec WorkerSpec, from, to string) WorkerSpec {
	out := WorkerSpec{Command: spec.Command, Args: make([]string, len(spec.Args)), Env: make([]EnvVar, len(spec.Env))}
	for i, a := range spec.Args {
		out.Args[i] = swapDir(a, from, to)
	}
	for i, e := range spec.Env {
		out.Env[i] = EnvVar{e.Key, swapDir(e.Value, from, to)}
	}
	out.Cwd = to
	if spec.Cwd != "" {
		out.Cwd = swapDir(spec.Cwd, from, to)
	}
	return out
}
