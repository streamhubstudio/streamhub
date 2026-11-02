package notify

import (
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/gosnmp/gosnmp"
)

func v2cListenerParams() *gosnmp.GoSNMP {
	return &gosnmp.GoSNMP{Version: gosnmp.Version2c, Community: "public"}
}

// startTrapListener runs a gosnmp TrapListener on a free 127.0.0.1 UDP port
// and returns its address plus a channel of received packets.
func startTrapListener(t *testing.T, params *gosnmp.GoSNMP) (string, <-chan *gosnmp.SnmpPacket) {
	t.Helper()
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := pc.LocalAddr().String()
	_ = pc.Close()

	ch := make(chan *gosnmp.SnmpPacket, 16)
	tl := gosnmp.NewTrapListener()
	tl.Params = params
	tl.OnNewTrap = func(p *gosnmp.SnmpPacket, _ *net.UDPAddr) { ch <- p }
	errc := make(chan error, 1)
	go func() { errc <- tl.Listen(addr) }()
	select {
	case <-tl.Listening():
	case err := <-errc:
		t.Fatalf("trap listener: %v", err)
	case <-time.After(3 * time.Second):
		t.Fatal("trap listener did not start")
	}
	t.Cleanup(tl.Close)
	return addr, ch
}

// assertTrap checks the SNMPv2-Trap layout and every varbind value against e.
func assertTrap(t *testing.T, p *gosnmp.SnmpPacket, e Event, trapOID string) {
	t.Helper()
	if p.PDUType != gosnmp.SNMPv2Trap {
		t.Errorf("PDU type = %v, want SNMPv2Trap", p.PDUType)
	}
	v := p.Variables
	if len(v) != 11 {
		t.Fatalf("got %d varbinds, want 11: %+v", len(v), v)
	}
	if v[0].Name != "."+oidSysUpTime || v[0].Type != gosnmp.TimeTicks {
		t.Errorf("varbind 0 = %s %v, want sysUpTime.0 TimeTicks", v[0].Name, v[0].Type)
	}
	if v[1].Name != "."+oidSnmpTrapOID || v[1].Value != "."+trapOID {
		t.Errorf("snmpTrapOID = %s %v, want %s", v[1].Name, v[1].Value, trapOID)
	}
	byName := map[string]gosnmp.SnmpPDU{}
	for _, pdu := range v[2:] {
		byName[pdu.Name] = pdu
	}
	wantStr := map[string]string{
		OIDAlarmType:    e.Type,
		OIDAlarmChannel: e.Channel,
		OIDAlarmOutput:  e.Output,
		OIDAlarmMessage: e.Message,
		OIDAlarmValue:   strconv.FormatFloat(e.Value, 'f', -1, 64),
		OIDDeviceID:     e.Device,
		OIDEventID:      e.ID,
	}
	for oid, want := range wantStr {
		pdu, ok := byName["."+oid+".0"]
		if !ok {
			t.Errorf("missing varbind %s.0", oid)
			continue
		}
		b, _ := pdu.Value.([]byte)
		if pdu.Type != gosnmp.OctetString || string(b) != want {
			t.Errorf("%s.0 = %v %q, want %q", oid, pdu.Type, b, want)
		}
	}
	sev := byName["."+OIDAlarmSeverity+".0"]
	if sev.Type != gosnmp.Integer || sev.Value != severityCode(e.Severity) {
		t.Errorf("severity = %v %v, want %d", sev.Type, sev.Value, severityCode(e.Severity))
	}
	ts := byName["."+OIDAlarmTimestamp+".0"]
	if b, _ := ts.Value.([]byte); string(b) != string(dateAndTime(e.At)) {
		t.Errorf("timestamp = %x, want %x", b, dateAndTime(e.At))
	}
}

func recvTrap(t *testing.T, ch <-chan *gosnmp.SnmpPacket) *gosnmp.SnmpPacket {
	t.Helper()
	select {
	case p := <-ch:
		return p
	case <-time.After(3 * time.Second):
		t.Fatal("no trap received")
		return nil
	}
}

func TestSNMPv2cTrap(t *testing.T) {
	addr, traps := startTrapListener(t, v2cListenerParams())
	n := newTestNotifier(t, Config{SNMP: []SNMPTarget{{Address: addr, Version: "2c", Community: "enc-traps"}}}, fastOpts())

	raised := sampleEvent("input_loss", true)
	n.Send(raised)
	p := recvTrap(t, traps)
	if p.Version != gosnmp.Version2c || p.Community != "enc-traps" {
		t.Errorf("version/community = %v/%q", p.Version, p.Community)
	}
	assertTrap(t, p, raised, OIDAlarmRaised)

	cleared := sampleEvent("input_loss", false)
	cleared.Severity = "critical"
	n.Send(cleared)
	assertTrap(t, recvTrap(t, traps), cleared, OIDAlarmCleared)

	waitFor(t, "sent=2", func() bool { return n.Stats().Sent == 2 })
}

func TestSNMPv3Traps(t *testing.T) {
	const pass = "s3cretpass"
	cases := []struct {
		name      string
		target    SNMPTarget
		flags     gosnmp.SnmpV3MsgFlags
		auth      gosnmp.SnmpV3AuthProtocol
		priv      gosnmp.SnmpV3PrivProtocol
		engineHex bool // target sets EngineID explicitly
	}{
		{"authPriv SHA/AES", SNMPTarget{User: "u1", AuthProto: "SHA", AuthPass: pass, PrivProto: "AES", PrivPass: pass, EngineID: "0x8000000001020304"},
			gosnmp.AuthPriv, gosnmp.SHA, gosnmp.AES, true},
		{"authPriv SHA/AES derived engine id", SNMPTarget{User: "u1", AuthProto: "SHA", AuthPass: pass, PrivProto: "AES", PrivPass: pass},
			gosnmp.AuthPriv, gosnmp.SHA, gosnmp.AES, false},
		{"authPriv SHA256/AES256", SNMPTarget{User: "u2", AuthProto: "SHA256", AuthPass: pass, PrivProto: "AES256", PrivPass: pass},
			gosnmp.AuthPriv, gosnmp.SHA256, gosnmp.AES256, false},
		{"authPriv MD5/DES", SNMPTarget{User: "u3", AuthProto: "MD5", AuthPass: pass, PrivProto: "DES", PrivPass: pass},
			gosnmp.AuthPriv, gosnmp.MD5, gosnmp.DES, false},
		{"authNoPriv default SHA", SNMPTarget{User: "u4", AuthPass: pass},
			gosnmp.AuthNoPriv, gosnmp.SHA, gosnmp.NoPriv, false},
		{"noAuthNoPriv", SNMPTarget{User: "u5"},
			gosnmp.NoAuthNoPriv, gosnmp.NoAuth, gosnmp.NoPriv, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			n := newNotifier(Config{}, nil, fastOpts())
			n.SetDevice("enc-test-01")
			t.Cleanup(n.Close)

			engineID := n.engineID
			if c.engineHex {
				engineID = "\x80\x00\x00\x00\x01\x02\x03\x04"
			}
			listener := &gosnmp.GoSNMP{
				Version:       gosnmp.Version3,
				SecurityModel: gosnmp.UserSecurityModel,
				MsgFlags:      c.flags,
				SecurityParameters: &gosnmp.UsmSecurityParameters{
					UserName:                 c.target.User,
					AuthenticationProtocol:   c.auth,
					AuthenticationPassphrase: c.target.AuthPass,
					PrivacyProtocol:          c.priv,
					PrivacyPassphrase:        c.target.PrivPass,
					AuthoritativeEngineID:    engineID,
				},
			}
			addr, traps := startTrapListener(t, listener)
			tgt := c.target
			tgt.Address, tgt.Version = addr, "3"
			n.Update(Config{SNMP: []SNMPTarget{tgt}})

			e := sampleEvent("bitrate_drop", true)
			n.Send(e)
			p := recvTrap(t, traps)
			if p.Version != gosnmp.Version3 {
				t.Errorf("version = %v", p.Version)
			}
			if p.MsgFlags&gosnmp.AuthPriv != c.flags {
				t.Errorf("msgFlags = %v, want %v", p.MsgFlags, c.flags)
			}
			if p.MsgFlags&gosnmp.Reportable != 0 {
				t.Error("reportable flag set on an unconfirmed-class PDU")
			}
			usm, _ := p.SecurityParameters.(*gosnmp.UsmSecurityParameters)
			if usm == nil || usm.UserName != c.target.User || usm.AuthoritativeEngineID != engineID {
				t.Errorf("usm = %+v", usm)
			} else if usm.AuthoritativeEngineBoots != n.engineBoots {
				t.Errorf("engineBoots = %d, want %d", usm.AuthoritativeEngineBoots, n.engineBoots)
			}
			assertTrap(t, p, e, OIDAlarmRaised)

			e2 := sampleEvent("bitrate_drop", false)
			n.Send(e2)
			assertTrap(t, recvTrap(t, traps), e2, OIDAlarmCleared)
		})
	}
}

func TestSNMPv3WrongPassphraseRejected(t *testing.T) {
	n := newTestNotifier(t, Config{}, fastOpts())
	listener := &gosnmp.GoSNMP{
		Version:       gosnmp.Version3,
		SecurityModel: gosnmp.UserSecurityModel,
		MsgFlags:      gosnmp.AuthPriv,
		SecurityParameters: &gosnmp.UsmSecurityParameters{
			UserName:                 "u1",
			AuthenticationProtocol:   gosnmp.SHA,
			AuthenticationPassphrase: "the-right-pass",
			PrivacyProtocol:          gosnmp.AES,
			PrivacyPassphrase:        "the-right-pass",
			AuthoritativeEngineID:    n.engineID,
		},
	}
	addr, traps := startTrapListener(t, listener)
	n.Update(Config{SNMP: []SNMPTarget{{Address: addr, Version: "3", User: "u1", AuthPass: "a-wrong-pass", PrivPass: "a-wrong-pass"}}})
	n.Send(sampleEvent("black", true))
	waitFor(t, "sent", func() bool { return n.Stats().Sent == 1 }) // UDP: "sent" means handed to the socket
	select {
	case p := <-traps:
		t.Fatalf("trap with wrong credentials was accepted: %+v", p)
	case <-time.After(300 * time.Millisecond):
	}
}

func TestSNMPTargetConfigErrors(t *testing.T) {
	for _, c := range []struct {
		name string
		tgt  SNMPTarget
	}{
		{"bad version", SNMPTarget{Address: "127.0.0.1", Version: "1"}},
		{"no user", SNMPTarget{Address: "127.0.0.1", Version: "3"}},
		{"short auth pass", SNMPTarget{Address: "127.0.0.1", Version: "3", User: "u", AuthPass: "short"}},
		{"priv without auth", SNMPTarget{Address: "127.0.0.1", Version: "3", User: "u", PrivPass: "longenough"}},
		{"bad auth proto", SNMPTarget{Address: "127.0.0.1", Version: "3", User: "u", AuthProto: "SHA3", AuthPass: "longenough"}},
		{"bad priv proto", SNMPTarget{Address: "127.0.0.1", Version: "3", User: "u", AuthPass: "longenough", PrivProto: "3DES", PrivPass: "longenough"}},
		{"bad engine id", SNMPTarget{Address: "127.0.0.1", Version: "3", User: "u", EngineID: "zz"}},
		{"bad address", SNMPTarget{Address: "", Version: "2c"}},
	} {
		if tg := newSNMPTarget(c.tgt, defaultEngineID("h"), 1); tg.err == nil {
			t.Errorf("%s: expected config error", c.name)
		}
	}
	if tg := newSNMPTarget(SNMPTarget{Address: "127.0.0.1", Version: "v2c"}, defaultEngineID("h"), 1); tg.err != nil || tg.port != 162 || tg.community != "public" {
		t.Errorf("v2c defaults: %+v", tg)
	}
}
