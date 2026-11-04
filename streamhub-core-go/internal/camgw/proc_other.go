//go:build !linux

package camgw

import "os/exec"

func setChildAttrs(*exec.Cmd) {}
