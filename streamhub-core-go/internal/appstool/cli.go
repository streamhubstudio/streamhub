package appstool

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Env is the process environment lookup (os.Getenv in production).
type Env func(string) string

// Tool carries the I/O of one `apps` invocation.
type Tool struct {
	Root   string // repo root (holds apps.lock.json)
	Env    Env
	HTTP   *http.Client
	Stdout io.Writer
	Stderr io.Writer
}

// exitError carries the process exit code.
type exitError struct{ code int }

func (e exitError) Error() string { return fmt.Sprintf("exit %d", e.code) }

// Run dispatches `streamhub-core apps <pull|pack|bump> …` and returns the
// exit code.
func Run(args []string, stdout, stderr io.Writer) int {
	t := &Tool{Env: os.Getenv, HTTP: http.DefaultClient, Stdout: stdout, Stderr: stderr}
	t.Root = FindRoot(os.Getenv)
	return t.Run(args)
}

// Run is Run over an explicit Tool (tests).
func (t *Tool) Run(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(t.Stderr, usage)
		return 2
	}
	var err error
	switch args[0] {
	case "pull":
		err = t.Pull()
	case "pack":
		err = t.Pack(args[1:])
	case "bump":
		write := false
		for _, a := range args[1:] {
			write = write || a == "--write"
		}
		err = t.Bump(write)
	case "help", "-h", "--help":
		fmt.Fprintln(t.Stdout, usage)
		return 0
	default:
		fmt.Fprintln(t.Stderr, usage)
		return 2
	}
	var ex exitError
	if errors.As(err, &ex) {
		return ex.code
	}
	if err != nil {
		fmt.Fprintln(t.Stderr, err)
		return 1
	}
	return 0
}

const usage = `usage: streamhub-core apps <command>

  pull                 compose every app pinned in apps.lock.json into the build
                       (verifies the CONTENT sha256, fails closed)
  pack --manifest F [--worker D] [--worker-sdk D] [--frontend D] [--migrations D]
       [--version V] [--out DIR]
                       pack an app from its sources (an app repo's CI); the version
                       defaults to $CI_COMMIT_TAG (v-stripped), else the manifest's;
                       writes <out>/streamhub-app-<id>-<version>.tar.gz + .sha256
  bump [--write]       list newer gitlab releases of the pinned apps (dry-run);
                       --write updates apps.lock.json

Env: STREAMHUB_APPS_TOKEN (gitlab: sources; gldt-… = deploy token),
     STREAMHUB_APPS_GITLAB_HOST (default https://gitlab.com),
     STREAMHUB_REPO_ROOT (default: nearest ancestor of the cwd with apps.lock.json).`

// FindRoot is STREAMHUB_REPO_ROOT, else the nearest ancestor of the cwd that
// holds apps.lock.json (or a streamhub-core-go/ dir), else the cwd.
func FindRoot(env Env) string {
	if r := env("STREAMHUB_REPO_ROOT"); r != "" {
		abs, _ := filepath.Abs(r)
		return abs
	}
	wd, _ := os.Getwd()
	for dir := wd; ; dir = filepath.Dir(dir) {
		for _, marker := range []string{"apps.lock.json", "streamhub-core-go"} {
			if _, err := os.Stat(filepath.Join(dir, marker)); err == nil {
				return dir
			}
		}
		if dir == filepath.Dir(dir) {
			return wd
		}
	}
}

// die prints "<cmd>: msg" on stderr and fails with exit 1.
func (t *Tool) die(cmd, format string, a ...any) error {
	fmt.Fprintf(t.Stderr, "%s: %s\n", cmd, fmt.Sprintf(format, a...))
	return exitError{1}
}

func (t *Tool) logf(format string, a ...any) { fmt.Fprintf(t.Stdout, format+"\n", a...) }

func (t *Tool) env(k string) string {
	if t.Env == nil {
		return ""
	}
	return t.Env(k)
}

func (t *Tool) gitlabHost() string {
	if h := t.env("STREAMHUB_APPS_GITLAB_HOST"); h != "" {
		return h
	}
	return "https://gitlab.com"
}

func trimV(s string) string { return strings.TrimPrefix(s, "v") }
