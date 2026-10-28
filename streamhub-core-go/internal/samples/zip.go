package samples

import (
	"encoding/binary"
	"hash/crc32"
)

// ZipEntry is one archive member (zip.ts).
type ZipEntry struct {
	Name string
	Data []byte
}

// Fixed DOS timestamp (1980-01-01 00:00:00) for reproducible zips.
const (
	dosTime = 0
	dosDate = 0x0021
)

// CreateZip builds a STORE-method (uncompressed) ZIP archive, byte-identical
// to zip.ts createZip.
func CreateZip(entries []ZipEntry) []byte {
	var local, central []byte
	le16 := binary.LittleEndian.AppendUint16
	le32 := binary.LittleEndian.AppendUint32
	offset := uint32(0)
	for _, e := range entries {
		name := []byte(e.Name)
		crc := crc32.ChecksumIEEE(e.Data)
		size := uint32(len(e.Data))

		h := make([]byte, 0, 30)
		h = le32(h, 0x04034b50)
		h = le16(h, 20)
		h = le16(h, 0)
		h = le16(h, 0)
		h = le16(h, dosTime)
		h = le16(h, dosDate)
		h = le32(h, crc)
		h = le32(h, size)
		h = le32(h, size)
		h = le16(h, uint16(len(name)))
		h = le16(h, 0)
		local = append(append(append(local, h...), name...), e.Data...)

		c := make([]byte, 0, 46)
		c = le32(c, 0x02014b50)
		c = le16(c, 20)
		c = le16(c, 20)
		c = le16(c, 0)
		c = le16(c, 0)
		c = le16(c, dosTime)
		c = le16(c, dosDate)
		c = le32(c, crc)
		c = le32(c, size)
		c = le32(c, size)
		c = le16(c, uint16(len(name)))
		c = le16(c, 0)
		c = le16(c, 0)
		c = le16(c, 0)
		c = le16(c, 0)
		c = le32(c, 0)
		c = le32(c, offset)
		central = append(append(central, c...), name...)

		offset += uint32(len(h) + len(name) + len(e.Data))
	}
	eocd := make([]byte, 0, 22)
	eocd = le32(eocd, 0x06054b50)
	eocd = le16(eocd, 0)
	eocd = le16(eocd, 0)
	eocd = le16(eocd, uint16(len(entries)))
	eocd = le16(eocd, uint16(len(entries)))
	eocd = le32(eocd, uint32(len(central)))
	eocd = le32(eocd, uint32(len(local)))
	eocd = le16(eocd, 0)

	out := make([]byte, 0, len(local)+len(central)+len(eocd))
	return append(append(append(out, local...), central...), eocd...)
}
