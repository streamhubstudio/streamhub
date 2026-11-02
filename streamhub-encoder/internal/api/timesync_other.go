//go:build !linux

package api

// ReadTimeStatus is only implemented on Linux.
func ReadTimeStatus() TimeStatus { return TimeStatus{Note: "not supported on this OS"} }
