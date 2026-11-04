package camgw

import (
	"os/exec"
	"syscall"
)

// setChildAttrs makes the kernel kill ffmpeg when the agent dies: a crashed
// agent must not leave a second RTSP session and relay running behind the
// respawned one (seen with the C agent on the Luckfox).
func setChildAttrs(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}
