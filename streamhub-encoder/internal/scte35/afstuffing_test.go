package scte35

import "testing"

// mpegtsmux (GStreamer) pads PSI packets with adaptation-field stuffing in
// front of the section instead of 0xFF after it: the PMT rewrite must handle it.
func afStuffedPSI(pid uint16, cc byte, sec []byte) []byte {
	p := make([]byte, PacketSize)
	p[0], p[1], p[2], p[3] = 0x47, 0x40|byte(pid>>8), byte(pid), 0x30|cc
	payload := append([]byte{0}, sec...) // pointer_field + section
	afLen := PacketSize - 4 - 1 - len(payload)
	p[4] = byte(afLen)
	if afLen > 0 {
		p[5] = 0x00
		for i := 6; i < 5+afLen; i++ {
			p[i] = 0xFF
		}
	}
	copy(p[5+afLen:], payload)
	return p
}

func TestPMTRewriteWithAdaptationFieldStuffing(t *testing.T) {
	pat := appendCRC([]byte{0x00, 0xB0, 0x0D, 0x00, 0x01, 0xC1, 0x00, 0x00, 0x00, 0x01, 0xE0, 0x20})
	pmt := appendCRC([]byte{0x02, 0xB0, 0x17, 0x00, 0x01, 0xC1, 0x00, 0x00, 0xE1, 0x00, 0xF0, 0x00,
		0x1B, 0xE1, 0x00, 0xF0, 0x00, 0x0F, 0xE1, 0x01, 0xF0, 0x00})
	// video PES with PTS = 90000 on PID 256
	pes := make([]byte, PacketSize)
	pes[0], pes[1], pes[2], pes[3] = 0x47, 0x41, 0x00, 0x10
	copy(pes[4:], []byte{0, 0, 1, 0xE0, 0, 0, 0x80, 0x80, 5, 0x21, 0x00, 0x05, 0xBF, 0x21})
	in := append(append(afStuffedPSI(0, 0, pat), afStuffedPSI(0x20, 0, pmt)...), pes...)
	inj := NewInjector(500)
	out := inj.Process(in)
	if st := inj.Stats(); st.PMTRewritten != 1 {
		t.Fatalf("PMT not rewritten: %+v", st)
	}
	if _, err := inj.Insert(Cue{Kind: KindSpliceInsert, EventID: 7, Immediate: true, OutOfNetwork: true}); err != nil {
		t.Fatal(err)
	}
	var ts []byte
	for _, d := range out {
		ts = append(ts, d...)
	}
	for _, d := range inj.Process(pes) {
		ts = append(ts, d...)
	}
	cues, err := ExtractSections(ts)
	if err != nil || len(cues) != 1 || cues[0].EventID != 7 {
		t.Fatalf("cue not found after AF-stuffed PMT rewrite: %+v %v", cues, err)
	}
}
