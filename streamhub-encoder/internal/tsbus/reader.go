package tsbus

import "io"

// AnalyzeReader runs the analyser over a recorded TS (file or pipe). Rates
// are averaged over the PCR-measured duration (stream time, not wall time).
func AnalyzeReader(r io.Reader) (Stats, error) {
	a := NewAnalyzer()
	buf := make([]byte, 188*512)
	var carry []byte
	var rerr error
	for {
		n, err := r.Read(buf)
		if n > 0 {
			data := append(carry, buf[:n]...)
			// resync on the first 0x47 if the stream does not start aligned
			if len(carry) == 0 && a.packets == 0 {
				for i := 0; i < len(data) && i < 188; i++ {
					if data[i] == 0x47 {
						data = data[i:]
						break
					}
				}
			}
			k := len(data) / 188 * 188
			a.Feed(data[:k])
			carry = append([]byte(nil), data[k:]...)
		}
		if err != nil {
			if err != io.EOF {
				rerr = err
			}
			break
		}
	}
	s := a.Stats()
	s.PCRDriftMs = 0 // the wall clock is meaningless offline
	// Duration: video PTS span + one frame (preferred), else the PCR span.
	dur := s.StreamSeconds
	if s.VideoSeconds > 0 && s.VideoFrames > 1 {
		dur = s.VideoSeconds * float64(s.VideoFrames) / float64(s.VideoFrames-1)
	}
	s.VideoSeconds = round1(s.VideoSeconds)
	if dur > 0 {
		s.BitrateKbps = round1(float64(s.Bytes) * 8 / dur / 1000)
		s.FPS = round1(float64(s.VideoFrames) / dur)
	}
	return s, rerr
}
