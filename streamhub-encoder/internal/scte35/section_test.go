package scte35

import (
	"encoding/base64"
	"errors"
	"testing"
)

func TestCRC32CheckValue(t *testing.T) {
	// Standard CRC-32/MPEG-2 check value.
	if got := CRC32([]byte("123456789")); got != 0x0376E6E7 {
		t.Fatalf("CRC32(123456789) = %#08x, want 0x0376e6e7", got)
	}
	s := appendCRC([]byte{0xFC, 0x30, 0x11, 1, 2, 3})
	if CRC32(s) != 0 {
		t.Fatalf("CRC over section+CRC must be 0")
	}
}

func mustB64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// Published SCTE-35 examples (splice_insert with avail_descriptor; time_signal
// with a segmentation_descriptor that omits the sub-segment fields).
func TestParseKnownVectors(t *testing.T) {
	t.Run("splice_insert", func(t *testing.T) {
		in, err := Parse(mustB64(t, "/DAvAAAAAAAA///wFAVIAACPf+/+c2nALv4AUsz1AAAAAAAKAAhDVUVJAAABNWLbowo="))
		if err != nil {
			t.Fatal(err)
		}
		checks := []struct {
			name      string
			got, want any
		}{
			{"CommandType", in.CommandType, uint8(CmdSpliceInsert)},
			{"Command", in.Command, "splice_insert"},
			{"SAPType", in.SAPType, uint8(3)},
			{"Tier", in.Tier, uint16(0xFFF)},
			{"PTSAdjustment", in.PTSAdjustment, uint64(0)},
			{"EventID", in.EventID, uint32(0x4800008F)},
			{"Cancel", in.Cancel, false},
			{"OutOfNetwork", in.OutOfNetwork, true},
			{"ProgramSplice", in.ProgramSplice, true},
			{"Immediate", in.Immediate, false},
			{"TimeSpecified", in.TimeSpecified, true},
			{"PTS", in.PTS, uint64(0x07369C02E)},
			{"HasDuration", in.HasDuration, true},
			{"Duration", in.Duration, uint64(0x00052CCF5)},
			{"AutoReturn", in.AutoReturn, true},
			{"UniqueProgramID", in.UniqueProgramID, uint16(0)},
			{"AvailNum", in.AvailNum, uint8(0)},
			{"AvailsExpected", in.AvailsExpected, uint8(0)},
			{"len(Descriptors)", len(in.Descriptors), 1},
			{"len(Segmentations)", len(in.Segmentations), 0},
		}
		for _, c := range checks {
			if c.got != c.want {
				t.Errorf("%s = %v, want %v", c.name, c.got, c.want)
			}
		}
		if d := in.Descriptors[0]; d.Tag != 0x00 || d.Identifier != cueiID || d.Length != 8 {
			t.Errorf("avail descriptor = %+v", d)
		}
	})
	t.Run("time_signal", func(t *testing.T) {
		in, err := Parse(mustB64(t, "/DA0AAAAAAAA///wBQb+cr0AUAAeAhxDVUVJSAAAjn/PAAGlmbAICAAAAAAsoKGKNAIAmsnRfg=="))
		if err != nil {
			t.Fatal(err)
		}
		if in.CommandType != CmdTimeSignal || !in.TimeSpecified || in.PTS != 0x072BD0050 {
			t.Fatalf("time_signal = %+v", in)
		}
		if len(in.Segmentations) != 1 {
			t.Fatalf("segmentations = %+v", in.Segmentations)
		}
		s := in.Segmentations[0]
		if s.EventID != 0x4800008E || s.TypeID != 0x34 || !s.HasDuration || s.Duration != 0x0001A599B0 ||
			s.UPIDType != 0x08 || len(s.UPID) != 8 || s.SegmentNum != 2 || s.SegmentsExpected != 0 {
			t.Fatalf("segmentation = %+v", s)
		}
	})
}

func TestEncodeParseRoundTrip(t *testing.T) {
	tests := []struct {
		name  string
		cue   Cue
		pts   uint64
		check func(t *testing.T, in Info)
	}{
		{
			name: "splice_insert immediate out",
			cue:  Cue{Kind: KindSpliceInsert, EventID: 7, OutOfNetwork: true, Immediate: true, UniqueProgramID: 0x1234, AvailNum: 1, AvailsExpected: 2},
			check: func(t *testing.T, in Info) {
				if in.CommandType != CmdSpliceInsert || in.EventID != 7 || !in.OutOfNetwork || !in.Immediate ||
					!in.ProgramSplice || in.TimeSpecified || in.HasDuration ||
					in.UniqueProgramID != 0x1234 || in.AvailNum != 1 || in.AvailsExpected != 2 {
					t.Fatalf("%+v", in)
				}
			},
		},
		{
			name: "splice_insert scheduled with duration",
			cue:  Cue{Kind: KindSpliceInsert, EventID: 0xDEADBEEF, OutOfNetwork: true, DurationMs: 30000},
			pts:  (1 << 32) + 12345, // exercises bit 32
			check: func(t *testing.T, in Info) {
				if in.EventID != 0xDEADBEEF || in.Immediate || !in.TimeSpecified || in.PTS != (1<<32)+12345 ||
					!in.HasDuration || !in.AutoReturn || in.Duration != 30000*90 {
					t.Fatalf("%+v", in)
				}
			},
		},
		{
			name: "splice_insert cue-in",
			cue:  Cue{Kind: KindSpliceInsert, EventID: 8, OutOfNetwork: false},
			pts:  900000,
			check: func(t *testing.T, in Info) {
				if in.OutOfNetwork || in.HasDuration || in.PTS != 900000 {
					t.Fatalf("%+v", in)
				}
			},
		},
		{
			name: "time_signal with segmentation 0x34",
			cue:  Cue{Kind: KindTimeSignal, EventID: 42, SegmentationTypeID: 0x34, DurationMs: 60000},
			pts:  123456789,
			check: func(t *testing.T, in Info) {
				if in.CommandType != CmdTimeSignal || !in.TimeSpecified || in.PTS != 123456789 || len(in.Segmentations) != 1 {
					t.Fatalf("%+v", in)
				}
				s := in.Segmentations[0]
				if s.EventID != 42 || s.TypeID != 0x34 || !s.HasDuration || s.Duration != 60000*90 || s.Cancel {
					t.Fatalf("seg %+v", s)
				}
				if d := in.Descriptors[0]; d.Tag != 0x02 || d.Identifier != cueiID {
					t.Fatalf("desc %+v", d)
				}
			},
		},
		{
			name: "time_signal 0x35 without duration",
			cue:  Cue{Kind: KindTimeSignal, EventID: 43, SegmentationTypeID: 0x35},
			pts:  5,
			check: func(t *testing.T, in Info) {
				if len(in.Segmentations) != 1 || in.Segmentations[0].TypeID != 0x35 || in.Segmentations[0].HasDuration {
					t.Fatalf("%+v", in)
				}
			},
		},
		{
			name: "time_signal immediate without descriptor",
			cue:  Cue{Kind: KindTimeSignal, Immediate: true},
			check: func(t *testing.T, in Info) {
				if in.CommandType != CmdTimeSignal || in.TimeSpecified || len(in.Descriptors) != 0 {
					t.Fatalf("%+v", in)
				}
			},
		},
		{
			name: "splice_null",
			cue:  Cue{Kind: KindSpliceNull},
			check: func(t *testing.T, in Info) {
				if in.CommandType != CmdSpliceNull || in.Command != "splice_null" {
					t.Fatalf("%+v", in)
				}
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			sec, err := Encode(tc.cue, tc.pts)
			if err != nil {
				t.Fatal(err)
			}
			// Header invariants: table_id, section_syntax=0, private=0, sap_type=3,
			// protocol 0, unencrypted, tier 0xFFF, splice_command_length matches.
			if sec[0] != 0xFC || sec[1]&0xF0 != 0x30 || sec[3] != 0 || sec[4]&0x80 != 0 {
				t.Fatalf("bad header % x", sec[:14])
			}
			if 3+(int(sec[1]&0x0F)<<8|int(sec[2])) != len(sec) {
				t.Fatalf("section_length mismatch")
			}
			if tier := uint16(sec[10])<<4 | uint16(sec[11]>>4); tier != 0xFFF {
				t.Fatalf("tier %#x", tier)
			}
			in, err := Parse(append(sec, 0xFF, 0xFF)) // trailing stuffing is ignored
			if err != nil {
				t.Fatal(err)
			}
			tc.check(t, in)
		})
	}
}

func TestParsePTSAdjustment(t *testing.T) {
	sec, _ := Encode(Cue{Kind: KindTimeSignal}, mask33-10)
	// Set pts_adjustment = 100 and re-sign.
	sec[8] = 100
	sec = appendCRC(sec[:len(sec)-4])
	in, err := Parse(sec)
	if err != nil {
		t.Fatal(err)
	}
	if in.PTSAdjustment != 100 || in.PTS != 89 { // (2^33-1-10+100) mod 2^33
		t.Fatalf("adj=%d pts=%d", in.PTSAdjustment, in.PTS)
	}
}

func TestParseErrors(t *testing.T) {
	good, _ := Encode(Cue{Kind: KindSpliceInsert, EventID: 1, Immediate: true}, 0)
	corrupt := append([]byte(nil), good...)
	corrupt[15] ^= 0x01
	badTable := append([]byte(nil), good...)
	badTable[0] = 0xFD
	tests := []struct {
		name string
		in   []byte
		want error
	}{
		{"crc mismatch", corrupt, ErrCRC},
		{"bad crc bytes", append(append([]byte(nil), good[:len(good)-1]...), good[len(good)-1]^0xFF), ErrCRC},
		{"table id", badTable, ErrTableID},
		{"truncated", good[:len(good)-3], ErrShort},
		{"tiny", good[:2], ErrShort},
		{"empty", nil, ErrShort},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Parse(tc.in); !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
	// A command longer than splice_command_length claims (but CRC-valid)
	// must be reported, not panic.
	trunc := []byte{0xFC, 0x30, 0x00, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xF0, 0x02, 0x05, 0, 0, 0, 0}
	trunc[2] = byte(len(trunc) + 4 - 3)
	trunc = appendCRC(trunc)
	if _, err := Parse(trunc); !errors.Is(err, ErrShort) {
		t.Fatalf("short command: err = %v", err)
	}
}

func TestEncodeUnknownKind(t *testing.T) {
	if _, err := Encode(Cue{Kind: "bogus"}, 0); err == nil {
		t.Fatal("want error")
	}
}
