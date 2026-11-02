//go:build linux

package api

import (
	"os"
	"strings"

	"golang.org/x/sys/unix"
)

// ReadTimeStatus asks the kernel (adjtimex) whether the clock is disciplined
// by NTP/PTP (chrony, systemd-timesyncd, ptp4l+phc2sys) and how good it is.
func ReadTimeStatus() TimeStatus {
	var tx unix.Timex
	state, err := unix.Adjtimex(&tx)
	if err != nil {
		return TimeStatus{Note: err.Error()}
	}
	ts := TimeStatus{
		Synchronized: state != unix.TIME_ERROR && tx.Status&unix.STA_UNSYNC == 0,
		MaxErrorUs:   int64(tx.Maxerror),
		EstErrorUs:   int64(tx.Esterror),
		Status:       tx.Status,
		Source:       "ntp",
	}
	off := float64(tx.Offset)
	if tx.Status&unix.STA_NANO != 0 {
		off /= 1000
	}
	ts.OffsetUs = off
	if ents, err := os.ReadDir("/dev"); err == nil {
		for _, e := range ents {
			if strings.HasPrefix(e.Name(), "ptp") {
				ts.Source = "ntp (PTP hardware clock present: " + e.Name() + ")"
				break
			}
		}
	}
	return ts
}
