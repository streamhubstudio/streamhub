package scte35

import (
	"errors"
	"fmt"
)

// Splice command types (ANSI/SCTE 35 2022 table 7).
const (
	CmdSpliceNull           = 0x00
	CmdSpliceSchedule       = 0x04
	CmdSpliceInsert         = 0x05
	CmdTimeSignal           = 0x06
	CmdBandwidthReservation = 0x07
	CmdPrivate              = 0xFF
)

// Cue kinds accepted by Injector.Insert.
const (
	KindSpliceInsert = "splice_insert"
	KindTimeSignal   = "time_signal"
	KindSpliceNull   = "splice_null"
)

const (
	tableID = 0xFC
	mask33  = 1<<33 - 1
	// cueiID is the "CUEI" format identifier (registration descriptor and
	// splice_descriptor identifier).
	cueiID = 0x43554549
	// DefaultPreRollMs is the pre-roll applied to scheduled cues when
	// Cue.PreRollMs is 0 (SCTE 67 recommends ≥ 4 s).
	DefaultPreRollMs = 4000
)

// Errors returned by Parse.
var (
	ErrShort     = errors.New("scte35: section truncated")
	ErrTableID   = errors.New("scte35: table_id is not 0xFC")
	ErrCRC       = errors.New("scte35: CRC-32 mismatch")
	ErrEncrypted = errors.New("scte35: encrypted section not supported")
)

// Cue is a request to signal a splice point.
//
// Kind is "splice_insert", "time_signal" or "splice_null" (the latter carries
// no other field). EventID is used verbatim as splice_event_id (and as
// segmentation_event_id for time_signal); keeping it unique is the caller's
// job. SegmentationTypeID is only honoured for time_signal.
type Cue struct {
	Kind               string `json:"kind"`                         // "splice_insert" | "time_signal" | "splice_null"
	EventID            uint32 `json:"eventId"`                      // splice_event_id / segmentation_event_id
	OutOfNetwork       bool   `json:"outOfNetwork"`                 // splice_insert: true = CUE-OUT, false = CUE-IN/return
	Immediate          bool   `json:"immediate"`                    // splice_immediate_flag (no pts)
	PreRollMs          int    `json:"preRollMs,omitempty"`          // when !Immediate: pts = last video PTS + preroll (0 → 4000)
	DurationMs         int    `json:"durationMs,omitempty"`         // >0 → break_duration (auto_return=1) / segmentation_duration
	UniqueProgramID    uint16 `json:"uniqueProgramId,omitempty"`    // splice_insert unique_program_id
	AvailNum           uint8  `json:"availNum,omitempty"`           // splice_insert avail_num
	AvailsExpected     uint8  `json:"availsExpected,omitempty"`     // splice_insert avails_expected
	SegmentationTypeID uint8  `json:"segmentationTypeId,omitempty"` // time_signal: segmentation_descriptor type (0 = none)
}

// Segmentation is a decoded segmentation_descriptor (tag 0x02, "CUEI").
type Segmentation struct {
	EventID             uint32 `json:"eventId"`
	Cancel              bool   `json:"cancel,omitempty"`
	TypeID              uint8  `json:"typeId"`
	HasDuration         bool   `json:"hasDuration,omitempty"`
	Duration            uint64 `json:"duration,omitempty"` // 90 kHz ticks
	UPIDType            uint8  `json:"upidType"`
	UPID                []byte `json:"upid,omitempty"`
	SegmentNum          uint8  `json:"segmentNum"`
	SegmentsExpected    uint8  `json:"segmentsExpected"`
	SubSegmentNum       uint8  `json:"subSegmentNum,omitempty"`
	SubSegmentsExpected uint8  `json:"subSegmentsExpected,omitempty"`
}

// Descriptor is the header of one splice_descriptor of the descriptor loop.
type Descriptor struct {
	Tag        uint8  `json:"tag"`
	Identifier uint32 `json:"identifier"` // 0x43554549 = "CUEI"
	Length     int    `json:"length"`
}

// Info is a decoded splice_info_section.
type Info struct {
	PID           uint16 `json:"pid,omitempty"` // set by ExtractSections
	SAPType       uint8  `json:"sapType"`
	PTSAdjustment uint64 `json:"ptsAdjustment"`
	Tier          uint16 `json:"tier"`
	CommandType   uint8  `json:"commandType"`
	Command       string `json:"command"`

	// splice_insert
	EventID         uint32 `json:"eventId,omitempty"`
	Cancel          bool   `json:"cancel,omitempty"`
	OutOfNetwork    bool   `json:"outOfNetwork,omitempty"`
	ProgramSplice   bool   `json:"programSplice,omitempty"`
	Immediate       bool   `json:"immediate,omitempty"`
	UniqueProgramID uint16 `json:"uniqueProgramId,omitempty"`
	AvailNum        uint8  `json:"availNum,omitempty"`
	AvailsExpected  uint8  `json:"availsExpected,omitempty"`

	// splice_time (splice_insert program splice or time_signal). PTS already
	// includes pts_adjustment (mod 2^33).
	TimeSpecified bool   `json:"timeSpecified,omitempty"`
	PTS           uint64 `json:"pts,omitempty"`

	// break_duration (splice_insert)
	HasDuration bool   `json:"hasDuration,omitempty"`
	Duration    uint64 `json:"duration,omitempty"` // 90 kHz ticks
	AutoReturn  bool   `json:"autoReturn,omitempty"`

	Descriptors   []Descriptor   `json:"descriptors,omitempty"`
	Segmentations []Segmentation `json:"segmentations,omitempty"`
}

// CommandName returns the SCTE-35 name of a splice_command_type.
func CommandName(t uint8) string {
	switch t {
	case CmdSpliceNull:
		return "splice_null"
	case CmdSpliceSchedule:
		return "splice_schedule"
	case CmdSpliceInsert:
		return "splice_insert"
	case CmdTimeSignal:
		return "time_signal"
	case CmdBandwidthReservation:
		return "bandwidth_reservation"
	case CmdPrivate:
		return "private_command"
	}
	return fmt.Sprintf("reserved_0x%02x", t)
}

// ---------------------------------------------------------------- encoding

// msToTicks converts milliseconds to 90 kHz ticks.
func msToTicks(ms int) uint64 { return uint64(ms) * 90 }

// appendSpliceTime appends splice_time(): time_specified_flag + 6 reserved
// bits + 33-bit pts_time, or time_specified_flag=0 + 7 reserved bits.
func appendSpliceTime(b []byte, specified bool, pts uint64) []byte {
	if !specified {
		return append(b, 0x7F)
	}
	pts &= mask33
	return append(b, 0xFE|byte(pts>>32), byte(pts>>24), byte(pts>>16), byte(pts>>8), byte(pts))
}

// appendBreakDuration appends break_duration(): auto_return + 6 reserved bits
// + 33-bit duration.
func appendBreakDuration(b []byte, autoReturn bool, d uint64) []byte {
	d &= mask33
	first := byte(0x7E) | byte(d>>32)
	if autoReturn {
		first |= 0x80
	}
	return append(b, first, byte(d>>24), byte(d>>16), byte(d>>8), byte(d))
}

// hasSubSegments reports whether segmentation_type_id carries
// sub_segment_num/sub_segments_expected (SCTE 35 2022 §10.3.3.1).
func hasSubSegments(t uint8) bool {
	switch t {
	case 0x30, 0x32, 0x34, 0x36, 0x38, 0x3A, 0x44, 0x46:
		return true
	}
	return false
}

// appendSegmentationDescriptor appends a segmentation_descriptor with
// program_segmentation_flag=1, delivery_not_restricted_flag=1, no UPID.
func appendSegmentationDescriptor(b []byte, eventID uint32, typeID uint8, dur uint64, hasDur bool) []byte {
	body := []byte{
		'C', 'U', 'E', 'I',
		byte(eventID >> 24), byte(eventID >> 16), byte(eventID >> 8), byte(eventID),
		0x7F, // cancel=0, event_id_compliance=1, reserved(6)
	}
	flags := byte(0xBF) // program_segmentation=1, duration=0, delivery_not_restricted=1, reserved(5)
	if hasDur {
		flags |= 0x40
	}
	body = append(body, flags)
	if hasDur {
		d := dur & (1<<40 - 1)
		body = append(body, byte(d>>32), byte(d>>24), byte(d>>16), byte(d>>8), byte(d))
	}
	body = append(body, 0x00, 0x00) // segmentation_upid_type=0 (not used), length 0
	body = append(body, typeID, 0, 0)
	if hasSubSegments(typeID) {
		body = append(body, 0, 0)
	}
	b = append(b, 0x02, byte(len(body)))
	return append(b, body...)
}

// buildSection wraps a splice command + descriptor loop in a
// splice_info_section (unencrypted, pts_adjustment 0, cw_index 0, tier 0xFFF,
// sap_type 3 = not specified) and appends the CRC.
func buildSection(cmdType uint8, cmd, desc []byte) []byte {
	secLen := 11 + len(cmd) + 2 + len(desc) + 4
	s := make([]byte, 0, 3+secLen)
	s = append(s,
		tableID,
		0x30|byte(secLen>>8)&0x0F, // section_syntax=0, private=0, sap_type=3
		byte(secLen),
		0x00,                         // protocol_version
		0x00, 0x00, 0x00, 0x00, 0x00, // encrypted=0, algorithm=0, pts_adjustment=0
		0x00, // cw_index
	)
	cl := len(cmd)
	s = append(s, 0xFF, 0xF0|byte(cl>>8)&0x0F, byte(cl), cmdType) // tier=0xFFF, splice_command_length
	s = append(s, cmd...)
	s = append(s, byte(len(desc)>>8), byte(len(desc)))
	s = append(s, desc...)
	return appendCRC(s)
}

// Encode builds the splice_info_section for c. pts is the splice time used
// when !c.Immediate (ignored otherwise).
func Encode(c Cue, pts uint64) ([]byte, error) {
	switch c.Kind {
	case KindSpliceNull:
		return buildSection(CmdSpliceNull, nil, nil), nil
	case KindSpliceInsert:
		cmd := []byte{byte(c.EventID >> 24), byte(c.EventID >> 16), byte(c.EventID >> 8), byte(c.EventID), 0x7F}
		f := byte(0x4F) // program_splice=1, event_id_compliance=1, reserved(3)
		if c.OutOfNetwork {
			f |= 0x80
		}
		if c.DurationMs > 0 {
			f |= 0x20
		}
		if c.Immediate {
			f |= 0x10
		}
		cmd = append(cmd, f)
		if !c.Immediate {
			cmd = appendSpliceTime(cmd, true, pts)
		}
		if c.DurationMs > 0 {
			cmd = appendBreakDuration(cmd, true, msToTicks(c.DurationMs))
		}
		cmd = append(cmd, byte(c.UniqueProgramID>>8), byte(c.UniqueProgramID), c.AvailNum, c.AvailsExpected)
		return buildSection(CmdSpliceInsert, cmd, nil), nil
	case KindTimeSignal:
		cmd := appendSpliceTime(nil, !c.Immediate, pts)
		var desc []byte
		if c.SegmentationTypeID != 0 {
			desc = appendSegmentationDescriptor(nil, c.EventID, c.SegmentationTypeID, msToTicks(c.DurationMs), c.DurationMs > 0)
		}
		return buildSection(CmdTimeSignal, cmd, desc), nil
	}
	return nil, fmt.Errorf("scte35: unknown cue kind %q", c.Kind)
}

// ---------------------------------------------------------------- decoding

// reader is a bounds-checked big-endian byte reader; the first short read
// latches err and every later read returns zero.
type reader struct {
	b   []byte
	pos int
	err error
}

func (r *reader) take(n int) []byte {
	if r.err != nil || n < 0 || r.pos+n > len(r.b) {
		r.err = ErrShort
		return nil
	}
	v := r.b[r.pos : r.pos+n]
	r.pos += n
	return v
}

func (r *reader) u8() uint8 {
	if v := r.take(1); v != nil {
		return v[0]
	}
	return 0
}

func (r *reader) u16() uint16 {
	if v := r.take(2); v != nil {
		return uint16(v[0])<<8 | uint16(v[1])
	}
	return 0
}

func (r *reader) u32() uint32 {
	if v := r.take(4); v != nil {
		return uint32(v[0])<<24 | uint32(v[1])<<16 | uint32(v[2])<<8 | uint32(v[3])
	}
	return 0
}

// u33 reads a 5-byte field whose low 33 bits are a value, returning the
// first byte (for its flag bits) and the value.
func (r *reader) u33() (uint8, uint64) {
	v := r.take(5)
	if v == nil {
		return 0, 0
	}
	return v[0], uint64(v[0]&1)<<32 | uint64(v[1])<<24 | uint64(v[2])<<16 | uint64(v[3])<<8 | uint64(v[4])
}

// spliceTime reads splice_time().
func (r *reader) spliceTime() (bool, uint64) {
	if r.err != nil || r.pos >= len(r.b) {
		r.err = ErrShort
		return false, 0
	}
	if r.b[r.pos]&0x80 == 0 {
		r.pos++
		return false, 0
	}
	_, pts := r.u33()
	return true, pts
}

// Parse decodes one splice_info_section (as found after the pointer field;
// trailing stuffing beyond section_length is ignored), verifies its CRC-32
// and returns the decoded fields. Encrypted sections return the header fields
// with ErrEncrypted.
func Parse(section []byte) (Info, error) {
	var in Info
	if len(section) < 3 {
		return in, ErrShort
	}
	if section[0] != tableID {
		return in, ErrTableID
	}
	total := 3 + (int(section[1]&0x0F)<<8 | int(section[2]))
	if total < 20 || len(section) < total {
		return in, ErrShort
	}
	sec := section[:total]
	if CRC32(sec) != 0 {
		return in, ErrCRC
	}
	in.SAPType = sec[1] >> 4 & 0x03
	r := &reader{b: sec[:total-4], pos: 4} // skip table_id, lengths, protocol_version
	encFirst, adj := r.u33()
	in.PTSAdjustment = adj
	r.u8() // cw_index
	tc := r.take(3)
	in.Tier = uint16(tc[0])<<4 | uint16(tc[1]>>4)
	cmdLen := int(tc[1]&0x0F)<<8 | int(tc[2])
	in.CommandType = r.u8()
	in.Command = CommandName(in.CommandType)
	if encFirst&0x80 != 0 {
		return in, ErrEncrypted
	}
	cmdStart := r.pos

	switch in.CommandType {
	case CmdSpliceInsert:
		in.EventID = r.u32()
		in.Cancel = r.u8()&0x80 != 0
		if !in.Cancel {
			f := r.u8()
			in.OutOfNetwork = f&0x80 != 0
			in.ProgramSplice = f&0x40 != 0
			durFlag := f&0x20 != 0
			in.Immediate = f&0x10 != 0
			if in.ProgramSplice && !in.Immediate {
				in.TimeSpecified, in.PTS = r.spliceTime()
			}
			if !in.ProgramSplice {
				n := int(r.u8())
				for range n {
					r.u8() // component_tag
					if !in.Immediate {
						r.spliceTime()
					}
				}
			}
			if durFlag {
				var first uint8
				first, in.Duration = r.u33()
				in.HasDuration = true
				in.AutoReturn = first&0x80 != 0
			}
			in.UniqueProgramID = r.u16()
			in.AvailNum = r.u8()
			in.AvailsExpected = r.u8()
		}
	case CmdTimeSignal:
		in.TimeSpecified, in.PTS = r.spliceTime()
	}
	if r.err != nil {
		return in, fmt.Errorf("%w (splice command)", r.err)
	}
	if in.TimeSpecified {
		in.PTS = (in.PTS + in.PTSAdjustment) & mask33
	}
	// splice_command_length 0xFFF is the legacy "unspecified" marker: trust
	// the parsed length then; otherwise the declared length wins (it also
	// skips commands we do not decode).
	if cmdLen != 0xFFF {
		r.pos = cmdStart
		r.take(cmdLen)
	}

	loopLen := int(r.u16())
	loop := r.take(loopLen)
	if r.err != nil {
		return in, fmt.Errorf("%w (descriptor loop)", r.err)
	}
	for len(loop) >= 2 {
		tag, l := loop[0], int(loop[1])
		if 2+l > len(loop) {
			return in, fmt.Errorf("%w (descriptor 0x%02x)", ErrShort, tag)
		}
		body := loop[2 : 2+l]
		loop = loop[2+l:]
		d := Descriptor{Tag: tag, Length: l}
		if l >= 4 {
			d.Identifier = uint32(body[0])<<24 | uint32(body[1])<<16 | uint32(body[2])<<8 | uint32(body[3])
		}
		in.Descriptors = append(in.Descriptors, d)
		if tag == 0x02 && d.Identifier == cueiID {
			sd, err := parseSegmentation(body[4:])
			if err != nil {
				return in, err
			}
			in.Segmentations = append(in.Segmentations, sd)
		}
	}
	return in, nil
}

// parseSegmentation decodes a segmentation_descriptor body after its
// identifier.
func parseSegmentation(b []byte) (Segmentation, error) {
	var s Segmentation
	r := &reader{b: b}
	s.EventID = r.u32()
	s.Cancel = r.u8()&0x80 != 0
	if !s.Cancel {
		f := r.u8()
		program := f&0x80 != 0
		s.HasDuration = f&0x40 != 0
		if !program {
			n := int(r.u8())
			r.take(6 * n) // component_tag(8) reserved(7) pts_offset(33)
		}
		if s.HasDuration {
			v := r.take(5)
			if v != nil {
				s.Duration = uint64(v[0])<<32 | uint64(v[1])<<24 | uint64(v[2])<<16 | uint64(v[3])<<8 | uint64(v[4])
			}
		}
		s.UPIDType = r.u8()
		if upid := r.take(int(r.u8())); len(upid) > 0 {
			s.UPID = append([]byte(nil), upid...)
		}
		s.TypeID = r.u8()
		s.SegmentNum = r.u8()
		s.SegmentsExpected = r.u8()
		// Older encoders omit the sub-segment fields: read them only when
		// present.
		if r.err == nil && hasSubSegments(s.TypeID) && len(b)-r.pos >= 2 {
			s.SubSegmentNum = r.u8()
			s.SubSegmentsExpected = r.u8()
		}
	}
	if r.err != nil {
		return s, fmt.Errorf("%w (segmentation_descriptor)", r.err)
	}
	return s, nil
}
