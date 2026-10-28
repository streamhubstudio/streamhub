package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"syscall"
	"time"
)

// server is one booted core (Node or Go) under test.
type server struct {
	label   string
	baseURL string
	cmd     *exec.Cmd
	logPath string
	logFile *os.File
	exited  chan struct{}
}

// serverSpec describes how to boot one core.
type serverSpec struct {
	label   string
	argv    []string // argv[0] = executable
	cwd     string   // working dir (holds a VERSION copy; Node writes openapi.json here)
	dataDir string
	logPath string
	env     map[string]string // overrides on top of baseEnv; PORT is set by start
}

// freePort asks the kernel for an unused loopback TCP port.
func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// processEnv builds a minimal, deterministic environment: only PATH/HOME/TMPDIR
// leak from the caller so a stray NODE_ENV or DATA_DIR in the operator's shell
// can never make the two runtimes diverge.
func processEnv(env map[string]string) []string {
	out := []string{}
	for _, k := range []string{"PATH", "HOME", "TMPDIR"} {
		if v, ok := os.LookupEnv(k); ok {
			out = append(out, k+"="+v)
		}
	}
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		out = append(out, k+"="+env[k])
	}
	return out
}

func startServer(ctx context.Context, spec serverSpec) (*server, error) {
	port, err := freePort()
	if err != nil {
		return nil, err
	}
	env := map[string]string{}
	for k, v := range spec.env {
		env[k] = v
	}
	env["PORT"] = strconv.Itoa(port)
	env["HOST"] = "127.0.0.1"
	env["DATA_DIR"] = spec.dataDir

	if err := os.MkdirAll(filepath.Dir(spec.logPath), 0o755); err != nil {
		return nil, err
	}
	lf, err := os.Create(spec.logPath)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(spec.argv[0], spec.argv[1:]...)
	cmd.Dir = spec.cwd
	cmd.Env = processEnv(env)
	cmd.Stdout = lf
	cmd.Stderr = lf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		lf.Close()
		return nil, fmt.Errorf("%s: start %s: %w", spec.label, spec.argv[0], err)
	}
	s := &server{
		label:   spec.label,
		baseURL: fmt.Sprintf("http://127.0.0.1:%d", port),
		cmd:     cmd,
		logPath: spec.logPath,
		logFile: lf,
		exited:  make(chan struct{}),
	}
	go func() {
		_ = cmd.Wait()
		close(s.exited)
	}()
	if err := s.waitHealthy(ctx, 60*time.Second); err != nil {
		s.stop()
		return nil, fmt.Errorf("%s: %w (log: %s)\n%s", spec.label, err, spec.logPath, tailFile(spec.logPath, 25))
	}
	return s, nil
}

func (s *server) waitHealthy(ctx context.Context, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		select {
		case <-s.exited:
			return fmt.Errorf("process exited before becoming healthy")
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		resp, err := client.Get(s.baseURL + "/api/v1/health")
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	return fmt.Errorf("not healthy after %s", timeout)
}

// stop sends SIGTERM to the process group (graceful: Node checkpoints its WAL,
// Go closes the DB), escalating to SIGKILL after 10s.
func (s *server) stop() {
	if s == nil || s.cmd.Process == nil {
		return
	}
	pgid := s.cmd.Process.Pid
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	select {
	case <-s.exited:
	case <-time.After(10 * time.Second):
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		<-s.exited
	}
	s.logFile.Close()
}

func tailFile(path string, lines int) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	n := 0
	for i := len(b) - 1; i >= 0; i-- {
		if b[i] == '\n' {
			n++
			if n > lines {
				return string(b[i+1:])
			}
		}
	}
	return string(b)
}

// copyDir copies a directory tree (regular files, dirs, symlinks).
func copyDir(src, dst string) error {
	return filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		switch {
		case info.IsDir():
			return os.MkdirAll(target, info.Mode().Perm()|0o700)
		case info.Mode()&os.ModeSymlink != 0:
			link, err := os.Readlink(p)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		case info.Mode().IsRegular():
			in, err := os.Open(p)
			if err != nil {
				return err
			}
			defer in.Close()
			out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, in); err != nil {
				out.Close()
				return err
			}
			return out.Close()
		}
		return nil // sockets, fifos: skip
	})
}
