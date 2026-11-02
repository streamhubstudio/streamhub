//go:build linux

package supervisor

import "syscall"

// Own process group + die with encoderd (no orphaned gst-launch after a crash).
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}
