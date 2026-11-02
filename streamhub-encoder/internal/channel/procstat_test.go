package channel

import (
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"testing"
	"time"
)

// An engine fed by ffmpeg is sh → (ffmpeg, gst-launch): the tree sample must
// include the children, not just the shell.
func TestReadProcTreeStatIncludesChildren(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("procfs")
	}
	if _, err := os.Stat("/proc/" + strconv.Itoa(os.Getpid()) + "/task/" + strconv.Itoa(os.Getpid()) + "/children"); err != nil {
		t.Skip("kernel without CONFIG_PROC_CHILDREN")
	}
	cmd := exec.Command("/bin/sh", "-c", "sleep 30 | sleep 30")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	deadline := time.Now().Add(3 * time.Second)
	for len(procChildren(cmd.Process.Pid)) < 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := len(procChildren(cmd.Process.Pid)); n < 2 {
		t.Fatalf("children of sh: %d", n)
	}
	one, tree := ReadProcStat(cmd.Process.Pid), ReadProcTreeStat(cmd.Process.Pid)
	if tree.RSSBytes <= one.RSSBytes || tree.Threads < one.Threads+2 {
		t.Fatalf("tree %+v not larger than the shell alone %+v", tree, one)
	}
	if ReadProcTreeStat(0) != (ProcStat{}) {
		t.Fatal("pid 0 must be zero")
	}
}
