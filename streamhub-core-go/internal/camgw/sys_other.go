//go:build !linux

package camgw

func memAvailableKB() int64                      { return -1 }
func load1() float64                             { return 0 }
func diskKB(string) (total, free int64, ok bool) { return 0, 0, false }
