package scte35

// crcTable is the byte-wise lookup table for CRC-32/MPEG-2
// (poly 0x04C11DB7, MSB-first, no reflection).
var crcTable = func() (t [256]uint32) {
	for i := range t {
		c := uint32(i) << 24
		for range 8 {
			if c&0x80000000 != 0 {
				c = c<<1 ^ 0x04C11DB7
			} else {
				c <<= 1
			}
		}
		t[i] = c
	}
	return t
}()

// CRC32 computes CRC-32/MPEG-2 (poly 0x04C11DB7, init 0xFFFFFFFF, no
// reflection, no final xor) — the CRC used by every MPEG-TS PSI section and
// by splice_info_section. Running it over a section *including* its trailing
// CRC_32 field yields 0 when the section is intact.
func CRC32(b []byte) uint32 {
	c := uint32(0xFFFFFFFF)
	for _, x := range b {
		c = c<<8 ^ crcTable[byte(c>>24)^x]
	}
	return c
}

// appendCRC appends the big-endian CRC-32/MPEG-2 of b to b.
func appendCRC(b []byte) []byte {
	c := CRC32(b)
	return append(b, byte(c>>24), byte(c>>16), byte(c>>8), byte(c))
}
