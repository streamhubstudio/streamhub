package notify

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gosnmp/gosnmp"
)

// EnterpriseOID is the root of STREAMHUB-ENCODER-MIB
// (docs/STREAMHUB-ENCODER-MIB.txt).
//
// PLACEHOLDER: 99999 is NOT an IANA-assigned Private Enterprise Number — we
// do not have one yet. Once a PEN is assigned, change this constant and the
// MODULE-IDENTITY in the MIB together; every OID below derives from it.
const EnterpriseOID = "1.3.6.1.4.1.99999.1"

// Notification (snmpTrapOID.0 values) and varbind object OIDs. Varbinds are
// accessible-for-notify scalars, so they are sent with the ".0" instance.
const (
	OIDAlarmRaised  = EnterpriseOID + ".0.1" // shEncAlarmRaised
	OIDAlarmCleared = EnterpriseOID + ".0.2" // shEncAlarmCleared

	OIDAlarmType      = EnterpriseOID + ".1.1" // shEncAlarmType (SnmpAdminString)
	OIDAlarmSeverity  = EnterpriseOID + ".1.2" // shEncAlarmSeverity (INTEGER enum)
	OIDAlarmChannel   = EnterpriseOID + ".1.3" // shEncAlarmChannel (SnmpAdminString)
	OIDAlarmOutput    = EnterpriseOID + ".1.4" // shEncAlarmOutput (SnmpAdminString)
	OIDAlarmMessage   = EnterpriseOID + ".1.5" // shEncAlarmMessage (SnmpAdminString)
	OIDAlarmValue     = EnterpriseOID + ".1.6" // shEncAlarmValue (decimal text)
	OIDDeviceID       = EnterpriseOID + ".1.7" // shEncDeviceId (SnmpAdminString)
	OIDEventID        = EnterpriseOID + ".1.8" // shEncEventId (SnmpAdminString)
	OIDAlarmTimestamp = EnterpriseOID + ".1.9" // shEncAlarmTimestamp (DateAndTime, UTC)

	oidSysUpTime   = "1.3.6.1.2.1.1.3.0"     // SNMPv2-MIB::sysUpTime.0
	oidSnmpTrapOID = "1.3.6.1.6.3.1.1.4.1.0" // SNMPv2-MIB::snmpTrapOID.0
)

// Severity values of shEncAlarmSeverity (ITU-T X.733 style).
const (
	SeverityCritical      = 1
	SeverityMajor         = 2
	SeverityMinor         = 3
	SeverityWarning       = 4
	SeverityInfo          = 5
	SeverityIndeterminate = 6 // unknown severity string
)

// severityCode maps an Event.Severity string to its MIB enumeration.
func severityCode(s string) int {
	switch strings.ToLower(s) {
	case "critical":
		return SeverityCritical
	case "major":
		return SeverityMajor
	case "minor":
		return SeverityMinor
	case "warning":
		return SeverityWarning
	case "info":
		return SeverityInfo
	}
	return SeverityIndeterminate
}

// pen is the enterprise number used in the derived snmpEngineID
// (RFC 3411 SnmpEngineID, first bit set). Same placeholder caveat as
// EnterpriseOID.
const pen = 99999

type snmpTarget struct {
	cfg       SNMPTarget
	label     string
	host      string
	port      uint16
	version   gosnmp.SnmpVersion
	community string
	msgFlags  gosnmp.SnmpV3MsgFlags
	usm       *gosnmp.UsmSecurityParameters // template with localized keys; Copy() per send
	err       error
}

// newSNMPTarget validates c and, for v3, pre-computes the localized USM keys
// (the password-to-key step hashes 1 MB, so it is done once, not per trap).
func newSNMPTarget(c SNMPTarget, defaultEngineID string, boots uint32) *snmpTarget {
	t := &snmpTarget{cfg: c}
	host, port, err := splitHostPort(c.Address)
	t.host, t.port = host, port

	ver := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(c.Version)), "v")
	switch ver {
	case "2c", "2":
		ver = "2c"
	case "3":
	default:
		ver = c.Version
	}
	t.label = "snmp v" + ver + " " + c.Address
	if err != nil {
		t.err = fmt.Errorf("%w: address: %v", errConfig, err)
		return t
	}

	switch ver {
	case "2c":
		t.version = gosnmp.Version2c
		t.community = c.Community
		if t.community == "" {
			t.community = "public"
		}
	case "3":
		t.version = gosnmp.Version3
		t.usm, t.msgFlags, err = buildUSM(c, defaultEngineID, boots)
		if err != nil {
			t.err = fmt.Errorf("%w: %v", errConfig, err)
		}
	default:
		t.err = fmt.Errorf("%w: unsupported snmp version %q (want \"2c\" or \"3\")", errConfig, c.Version)
	}
	return t
}

// splitHostPort parses "host[:port]" (IPv6 as "[::1]:162" or bare "::1"),
// defaulting the port to 162.
func splitHostPort(addr string) (string, uint16, error) {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return "", 0, fmt.Errorf("empty address")
	}
	host, ps, err := net.SplitHostPort(addr)
	if err != nil {
		// No port given.
		host, ps = strings.TrimSuffix(strings.TrimPrefix(addr, "["), "]"), "162"
	}
	if host == "" {
		return "", 0, fmt.Errorf("missing host")
	}
	p, err := strconv.ParseUint(ps, 10, 16)
	if err != nil || p == 0 {
		return "", 0, fmt.Errorf("invalid port %q", ps)
	}
	return host, uint16(p), nil
}

// buildUSM derives the USM parameters and security level from c.
func buildUSM(c SNMPTarget, defaultEngineID string, boots uint32) (*gosnmp.UsmSecurityParameters, gosnmp.SnmpV3MsgFlags, error) {
	if c.User == "" {
		return nil, 0, fmt.Errorf("snmpv3 user is required")
	}
	engineID := defaultEngineID
	if c.EngineID != "" {
		id, err := parseEngineID(c.EngineID)
		if err != nil {
			return nil, 0, err
		}
		engineID = id
	}
	sp := &gosnmp.UsmSecurityParameters{
		UserName:                 c.User,
		AuthoritativeEngineID:    engineID,
		AuthoritativeEngineBoots: boots,
		AuthenticationProtocol:   gosnmp.NoAuth,
		PrivacyProtocol:          gosnmp.NoPriv,
	}
	flags := gosnmp.NoAuthNoPriv
	if c.AuthPass != "" || c.AuthProto != "" {
		if len(c.AuthPass) < 8 {
			return nil, 0, fmt.Errorf("snmpv3 authPass must be at least 8 characters")
		}
		ap, err := authProto(c.AuthProto)
		if err != nil {
			return nil, 0, err
		}
		sp.AuthenticationProtocol, sp.AuthenticationPassphrase = ap, c.AuthPass
		flags = gosnmp.AuthNoPriv
	}
	if c.PrivPass != "" || c.PrivProto != "" {
		if flags == gosnmp.NoAuthNoPriv {
			return nil, 0, fmt.Errorf("snmpv3 privacy requires authentication (set authPass)")
		}
		if len(c.PrivPass) < 8 {
			return nil, 0, fmt.Errorf("snmpv3 privPass must be at least 8 characters")
		}
		pp, err := privProto(c.PrivProto)
		if err != nil {
			return nil, 0, err
		}
		sp.PrivacyProtocol, sp.PrivacyPassphrase = pp, c.PrivPass
		flags = gosnmp.AuthPriv
	}
	if err := sp.InitSecurityKeys(); err != nil {
		return nil, 0, fmt.Errorf("snmpv3 key localization: %v", err)
	}
	return sp, flags, nil
}

func authProto(s string) (gosnmp.SnmpV3AuthProtocol, error) {
	switch strings.ToUpper(strings.ReplaceAll(s, "-", "")) {
	case "", "SHA", "SHA1":
		return gosnmp.SHA, nil
	case "SHA224":
		return gosnmp.SHA224, nil
	case "SHA256":
		return gosnmp.SHA256, nil
	case "SHA384":
		return gosnmp.SHA384, nil
	case "SHA512":
		return gosnmp.SHA512, nil
	case "MD5":
		return gosnmp.MD5, nil
	}
	return 0, fmt.Errorf("unsupported snmpv3 authProto %q", s)
}

// privProto maps a privacy protocol name. AES192/AES256 use the Blumenthal
// key extension (draft-blumenthal-aes-usm); AES192C/AES256C the Reeder
// ("Cisco") one — pick whichever the manager implements.
func privProto(s string) (gosnmp.SnmpV3PrivProtocol, error) {
	switch strings.ToUpper(strings.ReplaceAll(s, "-", "")) {
	case "", "AES", "AES128":
		return gosnmp.AES, nil
	case "AES192":
		return gosnmp.AES192, nil
	case "AES256":
		return gosnmp.AES256, nil
	case "AES192C":
		return gosnmp.AES192C, nil
	case "AES256C":
		return gosnmp.AES256C, nil
	case "DES":
		return gosnmp.DES, nil
	}
	return 0, fmt.Errorf("unsupported snmpv3 privProto %q", s)
}

// parseEngineID decodes a hex snmpEngineID ("80001f8804..." with optional
// "0x" prefix and ':' / ' ' separators) into raw octets (5..32, RFC 3411).
func parseEngineID(s string) (string, error) {
	s = strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(s), "0x"), "0X")
	s = strings.NewReplacer(":", "", " ", "").Replace(s)
	b, err := hex.DecodeString(s)
	if err != nil {
		return "", fmt.Errorf("snmpv3 engineId must be hex: %v", err)
	}
	if len(b) < 5 || len(b) > 32 {
		return "", fmt.Errorf("snmpv3 engineId must be 5..32 octets, got %d", len(b))
	}
	return string(b), nil
}

// defaultEngineID builds an RFC 3411 snmpEngineID from the host name:
// 0x80|PEN (4 octets), format 4 (administratively assigned text), then up to
// 27 octets of text. Being stable across restarts lets managers keep one
// "createUser -e <id>" entry per encoder.
func defaultEngineID(host string) string {
	b := make([]byte, 5, 32)
	binary.BigEndian.PutUint32(b, 0x80000000|pen)
	b[4] = 4
	if len(host) > 27 {
		host = host[:27]
	}
	return string(append(b, host...))
}

// engineBootsAt returns snmpEngineBoots for a process started at t. We have
// no persistent boot counter, so we use the Unix start time: it strictly
// increases across restarts, which is what receivers' USM timeliness checks
// need (snmpEngineTime restarts from 0). Range 0..2147483647 holds until 2038.
func engineBootsAt(t time.Time) uint32 {
	return uint32(t.Unix()) & 0x7fffffff //nolint:gosec // masked to the USM range
}

// sysUpTime is hundredths of a second since the notifier started (TimeTicks wraps).
func (n *Notifier) sysUpTime() uint32 {
	return uint32(time.Since(n.start) / (10 * time.Millisecond)) //nolint:gosec // TimeTicks wraps by definition
}

// trapVars builds the SNMPv2-Trap varbind list for e.
func (n *Notifier) trapVars(e Event) []gosnmp.SnmpPDU {
	trapOID := OIDAlarmRaised
	if !e.Active {
		trapOID = OIDAlarmCleared
	}
	str := func(oid, v string) gosnmp.SnmpPDU {
		return gosnmp.SnmpPDU{Name: "." + oid + ".0", Type: gosnmp.OctetString, Value: truncate(v, 255)}
	}
	return []gosnmp.SnmpPDU{
		{Name: "." + oidSysUpTime, Type: gosnmp.TimeTicks, Value: n.sysUpTime()},
		{Name: "." + oidSnmpTrapOID, Type: gosnmp.ObjectIdentifier, Value: "." + trapOID},
		str(OIDAlarmType, e.Type),
		{Name: "." + OIDAlarmSeverity + ".0", Type: gosnmp.Integer, Value: severityCode(e.Severity)},
		str(OIDAlarmChannel, e.Channel),
		str(OIDAlarmOutput, e.Output),
		str(OIDAlarmMessage, e.Message),
		str(OIDAlarmValue, strconv.FormatFloat(e.Value, 'f', -1, 64)),
		str(OIDDeviceID, e.Device),
		str(OIDEventID, e.ID),
		{Name: "." + OIDAlarmTimestamp + ".0", Type: gosnmp.OctetString, Value: dateAndTime(e.At)},
	}
}

// truncate cuts s to at most max bytes on a UTF-8 boundary (SnmpAdminString
// is SIZE (0..255)).
func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// dateAndTime encodes t as an 11-octet SNMPv2-TC DateAndTime in UTC.
func dateAndTime(t time.Time) []byte {
	t = t.UTC()
	b := make([]byte, 11)
	binary.BigEndian.PutUint16(b, uint16(t.Year())) //nolint:gosec // years fit
	b[2], b[3] = byte(t.Month()), byte(t.Day())
	b[4], b[5], b[6] = byte(t.Hour()), byte(t.Minute()), byte(t.Second())
	b[7] = byte(t.Nanosecond() / 1e8) // deci-seconds
	b[8], b[9], b[10] = '+', 0, 0
	return b
}

// sendTrap sends one SNMPv2-Trap for e to t. Traps are unacknowledged UDP, so
// success means "encoded and handed to the socket"; only local errors (DNS,
// unreachable network, config) are reported.
func (n *Notifier) sendTrap(ctx context.Context, t *snmpTarget, e Event) error {
	if t.err != nil {
		return t.err
	}
	ctx, cancel := context.WithTimeout(ctx, snmpTimeout)
	defer cancel()
	g := &gosnmp.GoSNMP{
		Target:    t.host,
		Port:      t.port,
		Transport: "udp",
		Version:   t.version,
		Community: t.community,
		Timeout:   snmpTimeout,
		Retries:   0,
		MaxOids:   gosnmp.MaxOids,
		Context:   ctx,
	}
	if t.version == gosnmp.Version3 {
		sp := t.usm.Copy().(*gosnmp.UsmSecurityParameters)
		sp.AuthoritativeEngineTime = uint32(time.Since(n.start) / time.Second) //nolint:gosec // seconds since start
		g.SecurityModel = gosnmp.UserSecurityModel
		g.MsgFlags = t.msgFlags
		g.SecurityParameters = sp
	}
	if err := g.Connect(); err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer func() { _ = g.Close() }()
	if _, err := g.SendTrap(gosnmp.SnmpTrap{Variables: n.trapVars(e)}); err != nil {
		return fmt.Errorf("send trap: %w", err)
	}
	return nil
}
