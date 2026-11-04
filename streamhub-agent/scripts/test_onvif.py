"""Unit tests for scripts/onvif.py (ONVIF discovery + StreamHub registration).

Pure-logic tests in the same spirit as the StreamHub worker suites: every
socket/SOAP/HTTP boundary is mocked (fake UDP socket, canned ONVIF XML, fake
StreamHub API) — running them needs NOTHING beyond the stdlib and pytest, and
they must never touch the network.

    python3 -m pytest scripts/

Invariants locked down here:
  - WS-Discovery ProbeMatch parsing (XAddrs, scopes → name/hardware/MAC, dedupe)
  - WS-UsernameToken digest math (Base64(SHA1(nonce+created+password)))
  - Profile S parsing: GetDeviceInformation / GetProfiles / GetStreamUri
  - RTSP URI credential embedding (URL-encoding, ports, IPv6)
  - main/substream selection by resolution
  - StreamHub ingress payloads: {inputType:'url'} default, rtmp+passthrough opt-in
  - idempotent sync: register → keep → update-on-change → report-missing
"""

import base64
import hashlib
import json
import socket

import pytest

import onvif

# ── Canned ONVIF XML ────────────────────────────────────────────────

PROBE_MATCH = b"""<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"
    xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"
    xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery">
 <env:Body>
  <d:ProbeMatches>
   <d:ProbeMatch>
    <wsa:EndpointReference>
      <wsa:Address>urn:uuid:2419d68a-2dd2-21b2-a205-ec0bae329129</wsa:Address>
    </wsa:EndpointReference>
    <d:Types>dn:NetworkVideoTransmitter tds:Device</d:Types>
    <d:Scopes>onvif://www.onvif.org/type/video_encoder
      onvif://www.onvif.org/name/HIKVISION%20DS-2CD2043
      onvif://www.onvif.org/hardware/DS-2CD2043
      onvif://www.onvif.org/MAC/ec:0b:ae:32:91:29
      onvif://www.onvif.org/location/office</d:Scopes>
    <d:XAddrs>http://192.168.1.64/onvif/device_service
      http://[fe80::1]/onvif/device_service</d:XAddrs>
    <d:MetadataVersion>10</d:MetadataVersion>
   </d:ProbeMatch>
  </d:ProbeMatches>
 </env:Body>
</env:Envelope>"""

DEVICE_INFO_RESPONSE = b"""<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"
    xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
 <SOAP-ENV:Body>
  <tds:GetDeviceInformationResponse>
   <tds:Manufacturer>HIKVISION</tds:Manufacturer>
   <tds:Model>DS-2CD2043G0-I</tds:Model>
   <tds:FirmwareVersion>V5.6.3</tds:FirmwareVersion>
   <tds:SerialNumber>SER123456</tds:SerialNumber>
   <tds:HardwareId>88</tds:HardwareId>
  </tds:GetDeviceInformationResponse>
 </SOAP-ENV:Body>
</SOAP-ENV:Envelope>"""

CAPABILITIES_RESPONSE = b"""<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"
    xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
    xmlns:tt="http://www.onvif.org/ver10/schema">
 <SOAP-ENV:Body>
  <tds:GetCapabilitiesResponse><tds:Capabilities>
   <tt:Media><tt:XAddr>http://192.168.1.64/onvif/media_service</tt:XAddr></tt:Media>
  </tds:Capabilities></tds:GetCapabilitiesResponse>
 </SOAP-ENV:Body>
</SOAP-ENV:Envelope>"""

PROFILES_RESPONSE = b"""<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"
    xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
    xmlns:tt="http://www.onvif.org/ver10/schema">
 <SOAP-ENV:Body>
  <trt:GetProfilesResponse>
   <trt:Profiles token="Profile_1" fixed="true">
    <tt:Name>mainStream</tt:Name>
    <tt:VideoEncoderConfiguration token="VideoEncoder_1">
     <tt:Name>VideoEncoder_1</tt:Name>
     <tt:Encoding>H264</tt:Encoding>
     <tt:Resolution><tt:Width>2688</tt:Width><tt:Height>1520</tt:Height></tt:Resolution>
    </tt:VideoEncoderConfiguration>
   </trt:Profiles>
   <trt:Profiles token="Profile_2" fixed="true">
    <tt:Name>subStream</tt:Name>
    <tt:VideoEncoderConfiguration token="VideoEncoder_2">
     <tt:Name>VideoEncoder_2</tt:Name>
     <tt:Encoding>H264</tt:Encoding>
     <tt:Resolution><tt:Width>640</tt:Width><tt:Height>480</tt:Height></tt:Resolution>
    </tt:VideoEncoderConfiguration>
   </trt:Profiles>
  </trt:GetProfilesResponse>
 </SOAP-ENV:Body>
</SOAP-ENV:Envelope>"""

STREAM_URI_RESPONSE_TMPL = """<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"
    xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
    xmlns:tt="http://www.onvif.org/ver10/schema">
 <SOAP-ENV:Body>
  <trt:GetStreamUriResponse><trt:MediaUri>
   <tt:Uri>rtsp://192.168.1.64:554/Streaming/Channels/{channel}</tt:Uri>
   <tt:InvalidAfterConnect>false</tt:InvalidAfterConnect>
  </trt:MediaUri></trt:GetStreamUriResponse>
 </SOAP-ENV:Body>
</SOAP-ENV:Envelope>"""

NOT_AUTHORIZED_FAULT = b"""<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"
    xmlns:ter="http://www.onvif.org/ver10/error">
 <env:Body><env:Fault>
  <env:Code><env:Value>env:Sender</env:Value>
   <env:Subcode><env:Value>ter:NotAuthorized</env:Value></env:Subcode></env:Code>
  <env:Reason><env:Text xml:lang="en">Sender not authorized</env:Text></env:Reason>
 </env:Fault></env:Body>
</env:Envelope>"""

DATETIME_RESPONSE = b"""<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"
    xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
    xmlns:tt="http://www.onvif.org/ver10/schema">
 <SOAP-ENV:Body>
  <tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime>
   <tt:DateTimeType>NTP</tt:DateTimeType><tt:DaylightSavings>false</tt:DaylightSavings>
   <tt:UTCDateTime>
    <tt:Time><tt:Hour>{h}</tt:Hour><tt:Minute>{mi}</tt:Minute><tt:Second>{s}</tt:Second></tt:Time>
    <tt:Date><tt:Year>{y}</tt:Year><tt:Month>{mo}</tt:Month><tt:Day>{d}</tt:Day></tt:Date>
   </tt:UTCDateTime>
  </tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>
 </SOAP-ENV:Body>
</SOAP-ENV:Envelope>"""


def fake_device_post(valid_user=b"admin"):
    """Fake SOAP transport for a whole camera: routes on the request body and
    only answers authenticated calls that carry <wsse:Username>valid_user<."""

    def post(url, data, headers, timeout=None, insecure=False, method="POST"):
        if b"GetSystemDateAndTime" in data:
            import datetime
            now = datetime.datetime.now(datetime.timezone.utc)
            return 200, DATETIME_RESPONSE.replace(b"{h}", str(now.hour).encode()) \
                .replace(b"{mi}", str(now.minute).encode()) \
                .replace(b"{s}", str(now.second).encode()) \
                .replace(b"{y}", str(now.year).encode()) \
                .replace(b"{mo}", str(now.month).encode()) \
                .replace(b"{d}", str(now.day).encode())
        if b"<wsse:Username>" + valid_user + b"</wsse:Username>" not in data:
            return 400, NOT_AUTHORIZED_FAULT
        if b"GetDeviceInformation" in data:
            return 200, DEVICE_INFO_RESPONSE
        if b"GetCapabilities" in data:
            return 200, CAPABILITIES_RESPONSE
        if b"GetProfiles" in data:
            return 200, PROFILES_RESPONSE
        if b"GetStreamUri" in data:
            channel = b"101" if b"Profile_1" in data else b"102"
            return 200, STREAM_URI_RESPONSE_TMPL.format(
                channel=channel.decode()
            ).encode()
        return 500, b"unexpected request"

    return post


DEVICE = {
    "epr": "urn:uuid:2419d68a",
    "xaddrs": ["http://192.168.1.64/onvif/device_service"],
    "scopes": [],
    "name": "",
    "hardware": "",
    "mac": "ec:0b:ae:32:91:29",
    "ip": "192.168.1.64",
}


def make_settings(tmp_path, **overrides):
    settings = {
        "base_url": "https://media.example.com/api/v1",
        "app": "myapp",
        "token": "sk_test",
        "register_mode": "url",
        "prefer_stream": "main",
        "discovery_timeout": 1,
        "bind": "",
        "state_file": str(tmp_path / "onvif-cameras.json"),
        "default_credentials": [("admin", "admin")],
        "cameras": [],
    }
    settings.update(overrides)
    return settings


class FakeApi:
    def __init__(self):
        self.created, self.deleted, self.n = [], [], 0

    def create_ingress(self, payload):
        self.n += 1
        self.created.append(payload)
        data = {"ingressId": "IN_%d" % self.n}
        if payload.get("mode") == "passthrough":
            data["rtmp_url"] = "rtmp://media.example.com:1935/live/key%d" % self.n
            data["streamKey"] = "key%d" % self.n
            data["hls_url"] = "https://media.example.com/hls/myapp/x/index.m3u8"
        return data

    def delete_ingress(self, ingress_id):
        self.deleted.append(ingress_id)
        return True


# ── YAML subset parser ──────────────────────────────────────────────

AGENT_CONFIG = """
# comment
agent:
  id: agent-0001
  callback_url: media.example.com
  tenant: myapp
  encryption_key: ""

onvif:
  register_mode: url
  prefer_stream: main
  rescan_interval: 0
  default_credentials:
    - user: admin
      password: admin
    - user: root
      password: pass
  cameras:
    - match: 192.168.1.50
      user: viewer
      password: 'v#w:rd'
      mode: passthrough
      stream: sub

cameras:
  - id: c001
    rtsp: 'rtsp://u:p@192.168.1.50:554/ch1'
    detect:
      enabled: true
      mode: remote
"""


class TestParseYaml:
    def test_nested_maps_and_scalars(self):
        cfg = onvif.parse_yaml(AGENT_CONFIG)
        assert cfg["agent"]["callback_url"] == "media.example.com"
        assert cfg["agent"]["tenant"] == "myapp"
        assert cfg["agent"]["encryption_key"] == ""

    def test_list_of_maps(self):
        cfg = onvif.parse_yaml(AGENT_CONFIG)
        creds = cfg["onvif"]["default_credentials"]
        assert creds == [
            {"user": "admin", "password": "admin"},
            {"user": "root", "password": "pass"},
        ]

    def test_quoted_values_keep_special_chars(self):
        cfg = onvif.parse_yaml(AGENT_CONFIG)
        cam = cfg["onvif"]["cameras"][0]
        assert cam["password"] == "v#w:rd"
        assert cam["mode"] == "passthrough"
        assert cfg["cameras"][0]["rtsp"] == "rtsp://u:p@192.168.1.50:554/ch1"

    def test_nested_sub_block_inside_list_item(self):
        cfg = onvif.parse_yaml(AGENT_CONFIG)
        # detect: sub-block keys are folded into the camera item (flat subset)
        assert cfg["cameras"][0]["enabled"] == "true"

    def test_trailing_comment_stripped_on_unquoted_scalar(self):
        cfg = onvif.parse_yaml("agent:\n  tenant: myapp  # the app\n")
        assert cfg["agent"]["tenant"] == "myapp"

    def test_empty_input(self):
        assert onvif.parse_yaml("") == {}
        assert onvif.parse_yaml("# only comments\n") == {}


class TestLoadConfig:
    def write(self, tmp_path, config=AGENT_CONFIG, token="sk_live_123"):
        cfg = tmp_path / "config.yml"
        cfg.write_text(config)
        sec = tmp_path / "secrets.ini"
        sec.write_text("[streamhub]\napi_token = %s\n" % token)
        return str(cfg), str(sec)

    def test_reads_server_app_token(self, tmp_path):
        cfg, sec = self.write(tmp_path)
        settings = onvif.load_config(cfg, sec)
        assert settings["base_url"] == "https://media.example.com/api/v1"
        assert settings["app"] == "myapp"
        assert settings["token"] == "sk_live_123"

    def test_explicit_scheme_in_callback_url_wins(self, tmp_path):
        cfg, sec = self.write(
            tmp_path, AGENT_CONFIG.replace(
                "callback_url: media.example.com",
                "callback_url: http://127.0.0.1:3020",
            )
        )
        settings = onvif.load_config(cfg, sec)
        assert settings["base_url"] == "http://127.0.0.1:3020/api/v1"

    def test_default_state_file_next_to_config(self, tmp_path):
        cfg, sec = self.write(tmp_path)
        settings = onvif.load_config(cfg, sec)
        assert settings["state_file"] == str(tmp_path / "onvif-cameras.json")

    def test_credentials_as_tuples(self, tmp_path):
        cfg, sec = self.write(tmp_path)
        settings = onvif.load_config(cfg, sec)
        assert settings["default_credentials"] == [("admin", "admin"), ("root", "pass")]

    def test_app_alias(self, tmp_path):
        cfg, sec = self.write(
            tmp_path, AGENT_CONFIG.replace("tenant: myapp", "app: aliased")
        )
        assert onvif.load_config(cfg, sec)["app"] == "aliased"


# ── WS-Discovery ────────────────────────────────────────────────────

class TestProbe:
    def test_build_probe_shape(self):
        probe = onvif.build_probe("fixed-id")
        assert b"uuid:fixed-id" in probe
        assert b"NetworkVideoTransmitter" in probe
        assert b"discovery/Probe" in probe

    def test_parse_probe_match(self):
        devices = onvif.parse_probe_matches(PROBE_MATCH)
        assert len(devices) == 1
        dev = devices[0]
        assert dev["epr"] == "urn:uuid:2419d68a-2dd2-21b2-a205-ec0bae329129"
        assert dev["xaddrs"][0] == "http://192.168.1.64/onvif/device_service"
        assert dev["ip"] == "192.168.1.64"
        assert dev["name"] == "HIKVISION DS-2CD2043"  # URL-decoded scope
        assert dev["hardware"] == "DS-2CD2043"
        assert dev["mac"] == "ec:0b:ae:32:91:29"

    def test_parse_garbage_returns_empty(self):
        assert onvif.parse_probe_matches(b"not xml at all") == []
        assert onvif.parse_probe_matches(b"<a><b/></a>") == []

    def test_non_onvif_wsd_responder_filtered_out(self):
        # NAS/Windows WSD boxes answer probes too — they are not cameras
        nas = PROBE_MATCH.replace(
            b"dn:NetworkVideoTransmitter tds:Device", b"wsdp:Device pub:Computer"
        )
        nas = nas.replace(b"onvif://www.onvif.org", b"ldap:///ou=x")
        assert onvif.parse_probe_matches(nas) == []

    def test_scope_value_case_insensitive(self):
        scopes = ["onvif://www.onvif.org/NAME/Cam%201"]
        assert onvif.scope_value(scopes, "name") == "Cam 1"
        assert onvif.scope_value(scopes, "hardware") == ""

    def test_pick_xaddr_prefers_ipv4_literal(self):
        xaddrs = [
            "http://cam-host.local/onvif/device_service",
            "http://[fe80::1]/onvif/device_service",
            "http://192.168.1.64/onvif/device_service",
        ]
        assert onvif.pick_xaddr(xaddrs) == "http://192.168.1.64/onvif/device_service"
        # no literal → first one; empty list → empty string
        assert onvif.pick_xaddr(xaddrs[:2]) == xaddrs[0]
        assert onvif.pick_xaddr([]) == ""


class FakeSock:
    def __init__(self, datagrams):
        self.sent = []
        self.datagrams = list(datagrams)

    def sendto(self, data, addr):
        self.sent.append((data, addr))

    def settimeout(self, t):
        pass

    def recvfrom(self, n):
        if self.datagrams:
            return self.datagrams.pop(0), ("192.168.1.64", 3702)
        raise socket.timeout()

    def close(self):
        raise AssertionError("injected socket must not be closed by discover()")


class TestDiscover:
    def test_sends_probe_twice_to_multicast(self):
        sock = FakeSock([])
        onvif.discover(timeout=0.5, sock=sock)
        assert len(sock.sent) == 2
        assert sock.sent[0][1] == ("239.255.255.250", 3702)

    def test_collects_and_dedupes_devices(self):
        sock = FakeSock([PROBE_MATCH, PROBE_MATCH])  # same device answers twice
        devices = onvif.discover(timeout=0.5, sock=sock)
        assert len(devices) == 1
        assert devices[0]["ip"] == "192.168.1.64"


# ── WSSE / SOAP ─────────────────────────────────────────────────────

class TestWsse:
    def test_digest_vector(self):
        nonce = b"0123456789abcdef"
        created = "2026-07-09T12:00:00Z"
        header = onvif.wsse_header("admin", "secret", created=created, nonce=nonce)
        expected = base64.b64encode(
            hashlib.sha1(nonce + created.encode() + b"secret").digest()
        ).decode()
        assert expected in header
        assert base64.b64encode(nonce).decode() in header
        assert "<wsse:Username>admin</wsse:Username>" in header
        assert created in header

    def test_username_is_xml_escaped(self):
        header = onvif.wsse_header("a<b>&c", "x", nonce=b"n" * 16)
        assert "a&lt;b&gt;&amp;c" in header


class TestSoapCall:
    def test_success_parses_envelope(self):
        def post(url, data, headers, **kw):
            return 200, DEVICE_INFO_RESPONSE
        root = onvif.soap_call("http://cam/onvif", "<x/>", post=post)
        assert root.find(".//{*}Model") is not None

    def test_not_authorized_fault_raises_auth_error(self):
        def post(url, data, headers, **kw):
            return 400, NOT_AUTHORIZED_FAULT
        with pytest.raises(onvif.OnvifAuthError):
            onvif.soap_call("http://cam/onvif", "<x/>", post=post)

    def test_http_401_raises_auth_error(self):
        def post(url, data, headers, **kw):
            return 401, b""
        with pytest.raises(onvif.OnvifAuthError):
            onvif.soap_call("http://cam/onvif", "<x/>", post=post)

    def test_unparseable_body_raises_onvif_error(self):
        def post(url, data, headers, **kw):
            return 200, b"<<<"
        with pytest.raises(onvif.OnvifError):
            onvif.soap_call("http://cam/onvif", "<x/>", post=post)

    def test_transport_error_becomes_onvif_error(self):
        # a dead/unresolvable device must yield a per-device error, not a crash
        def post(url, data, headers, **kw):
            raise OSError("nodename nor servname provided")
        with pytest.raises(onvif.OnvifError, match="cannot reach"):
            onvif.soap_call("http://no-such-cam/onvif", "<x/>", post=post)

    def test_unreachable_device_reported_in_interrogate(self):
        def post(url, data, headers, **kw):
            raise OSError("connection refused")
        cam = onvif.interrogate(DEVICE, {"cameras": [], "default_credentials": []},
                                post=post)
        assert "device error" in cam["error"]
        assert cam["key"]  # identity preserved for the table/state

    def test_credentials_add_wsse_header(self):
        captured = {}

        def post(url, data, headers, **kw):
            captured["data"] = data
            return 200, DEVICE_INFO_RESPONSE

        onvif.soap_call("http://cam/onvif", "<x/>", creds=("admin", "pw"), post=post)
        assert b"<wsse:Username>admin</wsse:Username>" in captured["data"]
        assert b"PasswordDigest" in captured["data"]


# ── Profile S parsing ───────────────────────────────────────────────

class TestProfileS:
    def test_get_device_information(self):
        info = onvif.get_device_information(
            "http://cam/onvif", ("admin", "admin"), post=fake_device_post()
        )
        assert info == {
            "manufacturer": "HIKVISION",
            "model": "DS-2CD2043G0-I",
            "serial": "SER123456",
            "firmware": "V5.6.3",
        }

    def test_get_media_xaddr(self):
        xaddr = onvif.get_media_xaddr(
            "http://cam/onvif", ("admin", "admin"), post=fake_device_post()
        )
        assert xaddr == "http://192.168.1.64/onvif/media_service"

    def test_get_media_xaddr_falls_back_to_device_service(self):
        def post(url, data, headers, **kw):
            if b"GetSystemDateAndTime" in data:
                return 200, DATETIME_RESPONSE
            return 500, b"<broken"
        assert onvif.get_media_xaddr("http://cam/onvif", None, post=post) == "http://cam/onvif"

    def test_get_profiles(self):
        profiles = onvif.get_profiles(
            "http://cam/media", ("admin", "admin"), post=fake_device_post()
        )
        assert [p["token"] for p in profiles] == ["Profile_1", "Profile_2"]
        assert profiles[0]["name"] == "mainStream"
        assert (profiles[0]["width"], profiles[0]["height"]) == (2688, 1520)
        assert (profiles[1]["width"], profiles[1]["height"]) == (640, 480)

    def test_get_stream_uri(self):
        uri = onvif.get_stream_uri(
            "http://cam/media", "Profile_1", ("admin", "admin"),
            post=fake_device_post(),
        )
        assert uri == "rtsp://192.168.1.64:554/Streaming/Channels/101"

    def test_clock_skew_close_to_zero_for_synced_device(self):
        skew = onvif.get_clock_skew("http://cam/onvif", post=fake_device_post())
        assert abs(skew) < 5

    def test_clock_skew_zero_when_device_refuses(self):
        def post(url, data, headers, **kw):
            return 500, b"nope"
        assert onvif.get_clock_skew("http://cam/onvif", post=post) == 0.0


# ── RTSP URIs, identity, stream selection ───────────────────────────

class TestRtspUris:
    def test_embed_credentials(self):
        uri = onvif.embed_credentials(
            "rtsp://192.168.1.64:554/Streaming/Channels/101", "admin", "secret"
        )
        assert uri == "rtsp://admin:secret@192.168.1.64:554/Streaming/Channels/101"

    def test_embed_credentials_url_encodes(self):
        uri = onvif.embed_credentials("rtsp://cam:554/ch1", "us@er", "p:a/s@s")
        assert uri == "rtsp://us%40er:p%3Aa%2Fs%40s@cam:554/ch1"

    def test_embed_credentials_no_user_is_noop(self):
        assert onvif.embed_credentials("rtsp://cam/ch1", "", "x") == "rtsp://cam/ch1"

    def test_embed_credentials_keeps_query(self):
        uri = onvif.embed_credentials(
            "rtsp://cam:8554/live?channel=1&subtype=0", "u", "p"
        )
        assert uri == "rtsp://u:p@cam:8554/live?channel=1&subtype=0"


class TestSelectStreams:
    def test_main_is_highest_sub_is_lowest(self):
        profiles = [
            {"token": "b", "width": 640, "height": 480, "rtsp": "rtsp://x/2"},
            {"token": "a", "width": 2688, "height": 1520, "rtsp": "rtsp://x/1"},
            {"token": "c", "width": 1280, "height": 720, "rtsp": "rtsp://x/3"},
        ]
        main, sub = onvif.select_streams(profiles)
        assert main["token"] == "a"
        assert sub["token"] == "b"

    def test_single_profile_serves_both(self):
        profiles = [{"token": "only", "width": 1920, "height": 1080}]
        main, sub = onvif.select_streams(profiles)
        assert main is sub is profiles[0]

    def test_empty(self):
        assert onvif.select_streams([]) == (None, None)


class TestIdentity:
    def test_camera_key_precedence(self):
        assert onvif.camera_key({"serial": "S1", "mac": "M", "ip": "I"}) == "S1"
        assert onvif.camera_key({"serial": "", "mac": "M", "ip": "I"}) == "M"
        assert onvif.camera_key({"ip": "I"}) == "I"

    def test_room_slug(self):
        cam = {"serial": "DS-2CD2043 #99/ab"}
        room = onvif.room_for(cam)
        assert room == "onvif-ds-2cd2043-99-ab"

    def test_room_from_mac(self):
        assert onvif.room_for({"mac": "EC:0B:AE:32:91:29"}) == "onvif-ec-0b-ae-32-91-29"


# ── Credential selection ────────────────────────────────────────────

class TestCredentials:
    def test_per_camera_override_by_ip(self):
        cfg = {"cameras": [{"match": "192.168.1.64", "user": "u", "password": "p"}],
               "default_credentials": [("admin", "admin")]}
        cands = onvif.credential_candidates(cfg, {"ip": "192.168.1.64"})
        assert cands[0] == ("u", "p")
        assert cands[-1] is None  # anonymous last

    def test_override_by_mac_case_insensitive(self):
        cfg = {"cameras": [{"match": "EC-0B-AE-32-91-29", "user": "u", "password": "p"}],
               "default_credentials": []}
        entry = onvif.find_camera_override(cfg, {"ip": "x", "mac": "ec:0b:ae:32:91:29"})
        assert entry is not None and entry["user"] == "u"

    def test_defaults_when_no_override(self):
        cfg = {"cameras": [], "default_credentials": [("a", "1"), ("b", "2")]}
        cands = onvif.credential_candidates(cfg, {"ip": "10.0.0.9"})
        assert cands == [("a", "1"), ("b", "2"), None]

    def test_duplicates_removed(self):
        cfg = {"cameras": [{"match": "10.0.0.9", "user": "a", "password": "1"}],
               "default_credentials": [("a", "1")]}
        cands = onvif.credential_candidates(cfg, {"ip": "10.0.0.9"})
        assert cands == [("a", "1"), None]


# ── Interrogation (mocked device) ───────────────────────────────────

class TestInterrogate:
    def test_full_camera(self):
        cfg = {"cameras": [], "default_credentials": [("admin", "admin")]}
        cam = onvif.interrogate(DEVICE, cfg, post=fake_device_post())
        assert cam["error"] == ""
        assert cam["key"] == "SER123456"          # serial wins over MAC
        assert cam["model"] == "DS-2CD2043G0-I"
        assert cam["user"] == "admin"
        # credentials are embedded in the returned RTSP URIs
        assert cam["main_rtsp"] == \
            "rtsp://admin:admin@192.168.1.64:554/Streaming/Channels/101"
        assert cam["sub_rtsp"] == \
            "rtsp://admin:admin@192.168.1.64:554/Streaming/Channels/102"

    def test_tries_credential_list_in_order(self):
        cfg = {"cameras": [], "default_credentials": [("wrong", "x"), ("admin", "admin")]}
        cam = onvif.interrogate(DEVICE, cfg, post=fake_device_post())
        assert cam["error"] == ""
        assert cam["user"] == "admin"

    def test_auth_failure_reports_error_and_keeps_identity(self):
        cfg = {"cameras": [], "default_credentials": [("wrong", "x")]}
        cam = onvif.interrogate(DEVICE, cfg, post=fake_device_post())
        assert "auth failed" in cam["error"]
        assert cam["key"] == "ec:0b:ae:32:91:29"  # falls back to MAC
        assert cam["main_rtsp"] == ""

    def test_name_defaults_to_manufacturer_model(self):
        cfg = {"cameras": [], "default_credentials": [("admin", "admin")]}
        cam = onvif.interrogate(DEVICE, cfg, post=fake_device_post())
        assert cam["name"] == "HIKVISION DS-2CD2043G0-I"


# ── Ingress payloads (StreamHub API contract) ───────────────────────

class TestIngressPayload:
    CAM = {"serial": "SER123456", "name": "Front door", "ip": "192.168.1.64"}

    def test_url_mode_payload(self):
        payload = onvif.build_ingress_payload(
            self.CAM, "url", "rtsp://admin:x@192.168.1.64/ch1"
        )
        assert payload == {
            "inputType": "url",
            "url": "rtsp://admin:x@192.168.1.64/ch1",
            "room": "onvif-ser123456",
            "participantName": "Front door",
        }

    def test_passthrough_mode_payload(self):
        payload = onvif.build_ingress_payload(self.CAM, "passthrough", "rtsp://x/ch1")
        # passthrough is rtmp-push only in StreamHub — never inputType:'url'
        assert payload["inputType"] == "rtmp"
        assert payload["mode"] == "passthrough"
        assert "url" not in payload

    def test_registration_for_prefers_main_by_default(self, tmp_path):
        settings = make_settings(tmp_path)
        cam = {"ip": "1.2.3.4", "main_rtsp": "rtsp://m", "sub_rtsp": "rtsp://s"}
        assert onvif.registration_for(cam, settings) == ("url", "rtsp://m")

    def test_registration_for_per_camera_override(self, tmp_path):
        settings = make_settings(tmp_path, cameras=[
            {"match": "1.2.3.4", "mode": "passthrough", "stream": "sub"},
        ])
        cam = {"ip": "1.2.3.4", "main_rtsp": "rtsp://m", "sub_rtsp": "rtsp://s"}
        assert onvif.registration_for(cam, settings) == ("passthrough", "rtsp://s")


class TestStreamHubApi:
    def test_create_ingress_url_headers_payload(self):
        captured = {}

        def post(url, data, headers, insecure=False, method="POST", **kw):
            captured.update(url=url, data=data, headers=headers, method=method)
            return 201, json.dumps({"data": {"ingressId": "IN_1"}}).encode()

        api = onvif.StreamHubApi("https://hub/api/v1/", "shop", "sk_x", post=post)
        data = api.create_ingress({"inputType": "url", "url": "rtsp://c/1"})
        assert data["ingressId"] == "IN_1"
        assert captured["url"] == "https://hub/api/v1/apps/shop/ingress"
        assert captured["headers"]["Authorization"] == "Bearer sk_x"
        assert json.loads(captured["data"])["inputType"] == "url"

    def test_private_url_rejection_suggests_passthrough(self):
        def post(url, data, headers, **kw):
            return 400, json.dumps({
                "message": "ingress pull url points at a private/loopback/link-local address"
            }).encode()

        api = onvif.StreamHubApi("https://hub/api/v1", "shop", "sk_x", post=post)
        with pytest.raises(RuntimeError) as err:
            api.create_ingress({"inputType": "url", "url": "rtsp://192.168.1.5/ch"})
        assert "passthrough" in str(err.value)

    def test_delete_ingress_uses_delete_method(self):
        captured = {}

        def post(url, data, headers, insecure=False, method="POST", **kw):
            captured.update(url=url, method=method)
            return 200, b"{}"

        api = onvif.StreamHubApi("https://hub/api/v1", "shop", "sk_x", post=post)
        assert api.delete_ingress("IN_1") is True
        assert captured["method"] == "DELETE"
        assert captured["url"].endswith("/apps/shop/ingress/IN_1")


# ── State + idempotent sync ─────────────────────────────────────────

class TestState:
    def test_missing_file_yields_empty_state(self, tmp_path):
        state = onvif.load_state(str(tmp_path / "nope.json"))
        assert state == {"version": 1, "cameras": {}}

    def test_round_trip(self, tmp_path):
        path = str(tmp_path / "state.json")
        state = {"version": 1, "cameras": {"S1": {"ingress_id": "IN_1"}}}
        onvif.save_state(path, state)
        assert onvif.load_state(path)["cameras"]["S1"]["ingress_id"] == "IN_1"

    def test_corrupt_file_yields_empty_state(self, tmp_path):
        path = tmp_path / "state.json"
        path.write_text("{broken")
        assert onvif.load_state(str(path))["cameras"] == {}


class TestPlanSync:
    def cam(self, **over):
        cam = {"key": "S1", "ip": "1.1.1.1", "name": "cam", "error": "",
               "main_rtsp": "rtsp://m", "sub_rtsp": "rtsp://s"}
        cam.update(over)
        return cam

    def test_new_camera_registers(self, tmp_path):
        settings = make_settings(tmp_path)
        state = {"version": 1, "cameras": {}}
        actions = onvif.plan_sync([self.cam()], state, settings)
        assert [a for a, _, _ in actions] == ["register"]

    def test_unchanged_camera_keeps(self, tmp_path):
        settings = make_settings(tmp_path)
        state = {"version": 1, "cameras": {
            "S1": {"ingress_id": "IN_1", "rtsp": "rtsp://m", "mode": "url"}}}
        actions = onvif.plan_sync([self.cam()], state, settings)
        assert [a for a, _, _ in actions] == ["keep"]

    def test_changed_rtsp_updates(self, tmp_path):
        settings = make_settings(tmp_path)
        state = {"version": 1, "cameras": {
            "S1": {"ingress_id": "IN_1", "rtsp": "rtsp://old", "mode": "url"}}}
        actions = onvif.plan_sync([self.cam()], state, settings)
        assert [a for a, _, _ in actions] == ["update"]

    def test_changed_mode_updates(self, tmp_path):
        settings = make_settings(tmp_path, register_mode="passthrough")
        state = {"version": 1, "cameras": {
            "S1": {"ingress_id": "IN_1", "rtsp": "rtsp://m", "mode": "url"}}}
        actions = onvif.plan_sync([self.cam()], state, settings)
        assert [a for a, _, _ in actions] == ["update"]

    def test_error_camera_skips(self, tmp_path):
        settings = make_settings(tmp_path)
        state = {"version": 1, "cameras": {}}
        cam = self.cam(error="auth failed", main_rtsp="", sub_rtsp="")
        actions = onvif.plan_sync([cam], state, settings)
        assert [a for a, _, _ in actions] == ["skip"]

    def test_vanished_camera_reported_missing(self, tmp_path):
        settings = make_settings(tmp_path)
        state = {"version": 1, "cameras": {
            "GONE": {"ingress_id": "IN_9", "rtsp": "rtsp://x", "mode": "url"}}}
        actions = onvif.plan_sync([self.cam()], state, settings)
        assert ("missing", None, state["cameras"]["GONE"]) in actions


class TestSyncEndToEnd:
    def run_sync(self, settings, devices, api):
        return onvif.sync(
            settings,
            post=fake_device_post(),
            discover_fn=lambda timeout, bind: devices,
            api=api,
            out=lambda *a, **k: None,
        )

    def test_register_then_idempotent_keep(self, tmp_path):
        settings = make_settings(tmp_path)
        api = FakeApi()

        _state, summary = self.run_sync(settings, [DEVICE], api)
        assert summary["register"] == 1 and summary["error"] == 0
        assert len(api.created) == 1
        assert api.created[0]["inputType"] == "url"
        assert api.created[0]["url"].startswith("rtsp://admin:admin@192.168.1.64")

        # second run: nothing new is created — that's the idempotency contract
        _state, summary2 = self.run_sync(settings, [DEVICE], api)
        assert summary2 == {"register": 0, "update": 0, "keep": 1,
                            "skip": 0, "missing": 0, "error": 0}
        assert len(api.created) == 1

    def test_update_deletes_old_ingress_first(self, tmp_path):
        settings = make_settings(tmp_path)
        api = FakeApi()
        self.run_sync(settings, [DEVICE], api)

        settings["register_mode"] = "passthrough"
        _state, summary = self.run_sync(settings, [DEVICE], api)
        assert summary["update"] == 1
        assert api.deleted == ["IN_1"]
        assert api.created[-1]["inputType"] == "rtmp"
        assert api.created[-1]["mode"] == "passthrough"

    def test_passthrough_entry_records_push_url(self, tmp_path):
        settings = make_settings(tmp_path, register_mode="passthrough")
        api = FakeApi()
        state, _ = self.run_sync(settings, [DEVICE], api)
        entry = state["cameras"]["SER123456"]
        assert entry["rtmp_url"].startswith("rtmp://")
        assert entry["stream_key"]

    def test_missing_camera_reported_not_deleted(self, tmp_path):
        settings = make_settings(tmp_path)
        api = FakeApi()
        self.run_sync(settings, [DEVICE], api)

        reported = []
        _state, summary = onvif.sync(
            settings, post=fake_device_post(),
            discover_fn=lambda timeout, bind: [],
            api=api, out=reported.append,
        )
        assert summary["missing"] == 1
        assert api.deleted == []  # never auto-deleted
        assert any("MISSING" in line for line in reported)
        # state keeps the ingress mapping + a missing_since stamp
        state = onvif.load_state(settings["state_file"])
        assert state["cameras"]["SER123456"]["ingress_id"] == "IN_1"
        assert state["cameras"]["SER123456"]["missing_since"]

    def test_create_failure_counts_error_and_keeps_state_clean(self, tmp_path):
        settings = make_settings(tmp_path)

        class FailingApi(FakeApi):
            def create_ingress(self, payload):
                raise RuntimeError("ingress create failed (HTTP 400): nope")

        _state, summary = self.run_sync(settings, [DEVICE], FailingApi())
        assert summary["error"] == 1
        assert onvif.load_state(settings["state_file"])["cameras"] == {}

    def test_dry_run_registers_nothing(self, tmp_path):
        settings = make_settings(tmp_path)
        _state, summary = onvif.sync(
            settings, post=fake_device_post(),
            discover_fn=lambda timeout, bind: [DEVICE],
            api=None, out=lambda *a, **k: None, dry_run=True,
        )
        assert summary["register"] == 1
        # dry-run must not write the state file
        assert onvif.load_state(settings["state_file"])["cameras"] == {}


# ── Table output ────────────────────────────────────────────────────

class TestTable:
    def test_format_table_alignment(self):
        table = onvif.format_table(["A", "B"], [["x", "longer"], ["yy", "z"]])
        lines = table.splitlines()
        assert len(lines) == 4
        assert lines[0].startswith("A ")
        assert all(len(line) <= len(lines[1]) + 2 for line in lines)

    def test_scan_table_shows_registration(self, tmp_path):
        cam = {"key": "S1", "name": "Door", "model": "M1", "ip": "1.1.1.1",
               "serial": "S1", "main_rtsp": "rtsp://m", "sub_rtsp": "rtsp://s",
               "error": ""}
        state = {"version": 1, "cameras": {"S1": {"ingress_id": "IN_1", "mode": "url"}}}
        table = onvif.scan_table([cam], state)
        assert "IN_1 [url]" in table
        assert "rtsp://m" in table
