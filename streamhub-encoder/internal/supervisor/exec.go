package supervisor

import (
	"io"
	"os"
	"os/exec"
	"syscall"
)

// ExecRunner runs real processes, each in its own process group so stop and
// kill reach every helper the child may fork.
type ExecRunner struct {
	// SelfPath replaces Spec.Path "@self" (the encoderd binary).
	SelfPath string
}

type execProc struct{ cmd *exec.Cmd }

func (e execProc) Pid() int { return e.cmd.Process.Pid }
func (e execProc) Wait() error {
	return e.cmd.Wait()
}
func (e execProc) Interrupt() error { return syscall.Kill(-e.cmd.Process.Pid, syscall.SIGINT) }
func (e execProc) Kill() error      { return syscall.Kill(-e.cmd.Process.Pid, syscall.SIGKILL) }

// Start implements Runner.
func (r ExecRunner) Start(s Spec, out io.Writer) (Proc, error) {
	path := s.Path
	if path == "@self" {
		path = r.SelfPath
		if path == "" {
			p, err := os.Executable()
			if err != nil {
				return nil, err
			}
			path = p
		}
	}
	cmd := exec.Command(path, s.Args...)
	cmd.Env = append(os.Environ(), s.Env...)
	cmd.Stdout, cmd.Stderr = out, out
	cmd.SysProcAttr = sysProcAttr()
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return execProc{cmd}, nil
}
