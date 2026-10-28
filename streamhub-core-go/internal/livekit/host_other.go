//go:build !linux && !darwin

package livekit

func loadAvg() []float64 { return []float64{0, 0, 0} }

func memory() (total, free int64) { return 0, 0 }

func diskStats(string) *DiskStats { return nil }
