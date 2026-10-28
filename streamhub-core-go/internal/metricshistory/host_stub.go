//go:build !linux && !darwin

package metricshistory

// Other platforms: every source degrades to unknown (never fails).

func readCPUTimes() CPUTimes    { return CPUTimes{} }
func readLoadPercent() *float64 { return nil }
func readNet() *NetReading      { return nil }
func readMem() Usage            { return Usage{} }
func readDisk(string) *Usage    { return nil }
