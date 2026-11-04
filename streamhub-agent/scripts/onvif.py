#!/usr/bin/env python3
"""StreamHub Agent — ONVIF camera discovery + auto-registration.

Point the agent at the LAN and every ONVIF camera appears in StreamHub:

    streamhub-agent onvif scan     # discover + interrogate, print a table
    streamhub-agent onvif sync     # scan + register each camera in StreamHub

(the C binary dispatches the `onvif` subcommand to this script — see
src/onvif.c — but it also runs standalone: `python3 scripts/onvif.py ...`).

How it works
  1. WS-Discovery: a SOAP Probe is multicast on UDP 239.255.255.250:3702 and
     every ONVIF device on the LAN answers with a ProbeMatch (device service
     URL + scopes carrying name/hardware/MAC).
  2. ONVIF interrogation (Profile S): per device we call GetSystemDateAndTime
     (clock skew for the auth digest), GetDeviceInformation (model/serial),
     GetCapabilities (media service URL), GetProfiles and GetStreamUri per
     profile → the camera's RTSP URI(s), main + substream. Credentials come
     from config.yml `onvif.cameras` (per-camera) with an `onvif.
     default_credentials` try-list fallback (WS-UsernameToken digest auth).
  3. Registration (`sync`): each camera is registered in StreamHub via
     POST /api/v1/apps/<app>/ingress using the agent's existing settings
     (agent.callback_url + agent.tenant from config.yml, the sk_ token from
     secrets.ini [streamhub]):
       - mode `url` (default)   → {inputType:'url', url:'rtsp://...'} — the
         StreamHub server PULLS the camera's RTSP (transcode plane).
       - mode `passthrough`     → {inputType:'rtmp', mode:'passthrough'} —
         StreamHub mints an RTMP push key and remuxes straight to HLS (~0 CPU,
         HLS-wall use); the agent (or any ffmpeg -c copy) relays RTSP→RTMP.
     Re-runs are idempotent: a local state file (onvif-cameras.json, keyed by
     serial/MAC) maps each camera to its ingressId, so cameras are updated —
     never duplicated. Cameras that disappear are REPORTED, not auto-deleted.

Dependencies: NONE beyond the Python 3 standard library (socket + urllib +
xml.etree + hashlib). `onvif-zeep` was considered and rejected: it drags in
zeep/lxml/requests (~30 MB) for the four Profile S calls above, which matters
on the agent's embedded targets. The trade-off is that only WS-UsernameToken
digest auth and Profile S media are supported — exactly the MVP surface.
"""

import argparse
import base64
import configparser
import datetime
import hashlib
import json
import os
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape as xml_escape

# ── Constants ───────────────────────────────────────────────────────

WS_DISCOVERY_ADDR = ("239.255.255.250", 3702)
WS_DISCOVERY_TIMEOUT = 4          # seconds listening for ProbeMatches
SOAP_TIMEOUT = 8                  # per-device HTTP timeout
DEFAULT_STATE_BASENAME = "onvif-cameras.json"
STATE_VERSION = 1

PROBE_TEMPLATE = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"'
    ' xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"'
    ' xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"'
    ' xmlns:dn="http://www.onvif.org/ver10/network/wsdl">'
    '<e:Header>'
    '<w:MessageID>uuid:{mid}</w:MessageID>'
    '<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>'
    '<w:Action e:mustUnderstand="true">'
    'http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>'
    '</e:Header>'
    '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body>'
    '</e:Envelope>'
)

NS_MEDIA = "http://www.onvif.org/ver10/media/wsdl"
NS_DEVICE = "http://www.onvif.org/ver10/device/wsdl"
NS_SCHEMA = "http://www.onvif.org/ver10/schema"


class OnvifError(Exception):
    """SOAP/transport error talking to a device."""


class OnvifAuthError(OnvifError):
    """The device rejected the WS-UsernameToken credentials."""


# ── Minimal YAML subset parser ──────────────────────────────────────
# The agent's config.yml is a strict subset of YAML (see src/config.c: 2-space
# indentation, `key: value` scalars, lists of maps with `- key: value`). This
# parser handles exactly that subset so the script needs no PyYAML.

def parse_yaml(text):
    """Parse the agent's config.yml subset into dicts/lists/strings."""
    lines = []
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        lines.append((indent, stripped))
    value, _ = _parse_block(lines, 0, 0)
    return value if value is not None else {}


def _strip_quotes(val):
    val = val.strip()
    if len(val) >= 2 and val[0] == val[-1] and val[0] in "'\"":
        return val[1:-1]
    # strip trailing comments on unquoted scalars ("value  # comment")
    hash_pos = val.find(" #")
    if hash_pos >= 0:
        val = val[:hash_pos].rstrip()
    return val


def _split_key_value(content):
    key, _, val = content.partition(":")
    return key.strip(), _strip_quotes(val)


def _parse_block(lines, pos, indent):
    """Parse lines[pos:] at `indent`; returns (value, next_pos)."""
    if pos >= len(lines):
        return {}, pos
    if lines[pos][1].startswith("- ") or lines[pos][1] == "-":
        return _parse_list(lines, pos, indent)
    result = {}
    while pos < len(lines):
        line_indent, content = lines[pos]
        if line_indent < indent:
            break
        if line_indent > indent or content.startswith("- "):
            pos += 1  # stray deeper line (malformed) — skip defensively
            continue
        key, val = _split_key_value(content)
        pos += 1
        if val == "":
            # nested block (map or list) — or an intentionally empty scalar
            if pos < len(lines) and lines[pos][0] > line_indent:
                result[key], pos = _parse_block(lines, pos, lines[pos][0])
            else:
                result[key] = ""
        else:
            result[key] = val
    return result, pos


def _parse_list(lines, pos, indent):
    items = []
    while pos < len(lines):
        line_indent, content = lines[pos]
        if line_indent < indent or not (content.startswith("- ") or content == "-"):
            break
        inner = content[2:].strip() if content.startswith("- ") else ""
        if inner and ":" in inner:
            # map item: "- key: value" — the rest of the map is more-indented
            item = {}
            key, val = _split_key_value(inner)
            item[key] = val
            pos += 1
            while pos < len(lines) and lines[pos][0] > line_indent:
                k, v = _split_key_value(lines[pos][1])
                item[k] = v
                pos += 1
            items.append(item)
        else:
            items.append(_strip_quotes(inner))
            pos += 1
    return items, pos


# ── Agent configuration ─────────────────────────────────────────────

def as_int(val, default=0):
    try:
        return int(str(val).strip())
    except (ValueError, TypeError):
        return default


def load_config(config_path, secrets_path):
    """Read the agent's config.yml + secrets.ini into one settings dict."""
    with open(config_path, "r", encoding="utf-8") as f:
        cfg = parse_yaml(f.read())
    agent = cfg.get("agent", {}) if isinstance(cfg.get("agent"), dict) else {}
    onvif = cfg.get("onvif", {}) if isinstance(cfg.get("onvif"), dict) else {}

    token = ""
    if secrets_path and os.path.isfile(secrets_path):
        ini = configparser.ConfigParser()
        ini.read(secrets_path)
        token = ini.get("streamhub", "api_token", fallback="").strip()

    host = str(agent.get("callback_url", "")).strip()
    if host.startswith(("http://", "https://")):
        base_url = host.rstrip("/") + "/api/v1"
    else:
        base_url = "https://" + host + "/api/v1" if host else ""

    app = str(agent.get("tenant") or agent.get("app") or "").strip()

    state_file = str(onvif.get("state_file", "")).strip()
    if not state_file:
        state_file = os.path.join(
            os.path.dirname(os.path.abspath(config_path)), DEFAULT_STATE_BASENAME
        )

    default_creds = []
    for entry in onvif.get("default_credentials", []) or []:
        if isinstance(entry, dict) and entry.get("user"):
            default_creds.append((entry.get("user", ""), entry.get("password", "")))

    cameras = [e for e in (onvif.get("cameras", []) or []) if isinstance(e, dict)]

    return {
        "base_url": base_url,
        "app": app,
        "token": token,
        "register_mode": str(onvif.get("register_mode", "url")).strip() or "url",
        "prefer_stream": str(onvif.get("prefer_stream", "main")).strip() or "main",
        "discovery_timeout": as_int(onvif.get("discovery_timeout"), WS_DISCOVERY_TIMEOUT),
        "bind": str(onvif.get("bind", "")).strip(),
        "state_file": state_file,
        "default_credentials": default_creds,
        "cameras": cameras,
    }


# ── WS-Discovery (UDP multicast 3702) ───────────────────────────────

def build_probe(message_id=None):
    """WS-Discovery Probe datagram for NetworkVideoTransmitter devices."""
    return PROBE_TEMPLATE.format(mid=message_id or uuid.uuid4()).encode()


def _text(elem):
    return (elem.text or "").strip() if elem is not None else ""


def parse_probe_matches(data):
    """Parse one WS-Discovery response datagram → list of device dicts.

    Each device: {epr, xaddrs: [url...], scopes: [str...], name, hardware,
    mac, ip} — name/hardware/mac come from the onvif:// scopes when present.
    """
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return []
    devices = []
    for match in root.iter():
        if not match.tag.endswith("}ProbeMatch"):
            continue
        epr = ""
        for addr in match.iter():
            if addr.tag.endswith("}EndpointReference"):
                epr = _text(addr.find(".//{*}Address"))
                break
        xaddrs, scopes, types = [], [], ""
        for child in match.iter():
            if child.tag.endswith("}XAddrs"):
                xaddrs = _text(child).split()
            elif child.tag.endswith("}Scopes"):
                scopes = _text(child).split()
            elif child.tag.endswith("}Types"):
                types = _text(child)
        if not xaddrs:
            continue
        # Non-ONVIF WSD devices (Windows boxes, NAS, printers) answer probes
        # too — keep only devices that identify as ONVIF/NVT.
        is_onvif = "networkvideotransmitter" in types.lower() or any(
            s.lower().startswith("onvif://") for s in scopes
        )
        if not is_onvif:
            continue
        dev = {
            "epr": epr,
            "xaddrs": xaddrs,
            "scopes": scopes,
            "name": scope_value(scopes, "name"),
            "hardware": scope_value(scopes, "hardware"),
            "mac": scope_value(scopes, "mac"),
            "ip": urllib.parse.urlsplit(pick_xaddr(xaddrs)).hostname or "",
        }
        devices.append(dev)
    return devices


def pick_xaddr(xaddrs):
    """Prefer a device-service URL with an IPv4-literal host. Cameras often
    advertise several XAddrs (hostname, mDNS, IPv6 link-local) and the
    non-literal ones frequently do not resolve from the agent's network."""
    for url in xaddrs:
        host = urllib.parse.urlsplit(url).hostname or ""
        try:
            socket.inet_aton(host)
            return url
        except OSError:
            continue
    return xaddrs[0] if xaddrs else ""


def scope_value(scopes, kind):
    """Extract `onvif://www.onvif.org/<kind>/<value>` from the scope list."""
    prefix = "onvif://www.onvif.org/"
    for scope in scopes:
        if not scope.lower().startswith(prefix):
            continue
        rest = scope[len(prefix):]
        parts = rest.split("/", 1)
        if len(parts) == 2 and parts[0].lower() == kind.lower():
            return urllib.parse.unquote(parts[1])
    return ""


def discover(timeout=WS_DISCOVERY_TIMEOUT, bind="", sock=None):
    """Multicast a Probe and collect ProbeMatch answers for `timeout` seconds.

    `sock` is injectable for tests (needs sendto/recvfrom/settimeout/close).
    Devices are deduplicated by endpoint reference (fallback: first XAddr).
    """
    own_sock = sock is None
    if sock is None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
        sock.bind((bind, 0))
    try:
        probe = build_probe()
        # send twice — WS-Discovery is UDP, first datagram is often lost
        sock.sendto(probe, WS_DISCOVERY_ADDR)
        sock.sendto(probe, WS_DISCOVERY_ADDR)
        seen, devices = set(), []
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            sock.settimeout(remaining)
            try:
                data, _addr = sock.recvfrom(65535)
            except socket.timeout:
                break
            except OSError:
                break
            for dev in parse_probe_matches(data):
                key = dev["epr"] or dev["xaddrs"][0]
                if key in seen:
                    continue
                seen.add(key)
                devices.append(dev)
        return devices
    finally:
        if own_sock:
            sock.close()


# ── SOAP client (WS-UsernameToken digest auth) ──────────────────────

def wsse_header(user, password, created=None, nonce=None):
    """WS-Security UsernameToken header (PasswordDigest, ONVIF core spec)."""
    nonce = nonce if nonce is not None else os.urandom(16)
    created = created or datetime.datetime.now(datetime.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    digest = base64.b64encode(
        hashlib.sha1(nonce + created.encode() + password.encode()).digest()
    ).decode()
    return (
        '<s:Header><wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/'
        'oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open'
        '.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" s:mustUnderstand="1">'
        "<wsse:UsernameToken>"
        "<wsse:Username>{user}</wsse:Username>"
        '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-'
        'username-token-profile-1.0#PasswordDigest">{digest}</wsse:Password>'
        '<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-'
        'wss-soap-message-security-1.0#Base64Binary">{nonce}</wsse:Nonce>'
        "<wsu:Created>{created}</wsu:Created>"
        "</wsse:UsernameToken></wsse:Security></s:Header>"
    ).format(
        user=xml_escape(user),
        digest=digest,
        nonce=base64.b64encode(nonce).decode(),
        created=created,
    )


def soap_envelope(body_xml, header_xml=""):
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">'
        + header_xml
        + "<s:Body>"
        + body_xml
        + "</s:Body></s:Envelope>"
    ).encode()


def default_http_post(url, data, headers, timeout=SOAP_TIMEOUT, insecure=False,
                      method="POST"):
    """POST (or DELETE) bytes, return (status, body_bytes). Injectable for tests."""
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    ctx = None
    if url.startswith("https") and insecure:
        ctx = ssl._create_unverified_context()  # noqa: SLF001 — explicit opt-in
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()


def soap_call(url, body_xml, creds=None, post=None, skew=0.0):
    """POST a SOAP 1.2 request, return the parsed Envelope ElementTree root.

    `creds` = (user, password) → adds a WS-UsernameToken header with a Created
    timestamp shifted by `skew` seconds (device clock − our clock).
    Raises OnvifAuthError on auth faults, OnvifError otherwise.
    """
    post = post or default_http_post
    header = ""
    if creds:
        created = datetime.datetime.fromtimestamp(
            time.time() + skew, datetime.timezone.utc
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
        header = wsse_header(creds[0], creds[1], created=created)
    try:
        status, body = post(
            url,
            soap_envelope(body_xml, header),
            {"Content-Type": "application/soap+xml; charset=utf-8"},
        )
    except (urllib.error.URLError, OSError) as err:
        # unreachable/unresolvable device — a per-device error, never a crash
        raise OnvifError("cannot reach %s: %s" % (url, err))
    if status == 401:
        raise OnvifAuthError("HTTP 401 from %s" % url)
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        raise OnvifError("unparseable SOAP response from %s (HTTP %d)" % (url, status))
    fault = root.find(".//{*}Fault")
    if fault is not None:
        text = "".join(fault.itertext()).strip()
        if "NotAuthorized" in text or "Unauthorized" in text or "auth" in text.lower():
            raise OnvifAuthError(text[:200])
        raise OnvifError(text[:200] or ("SOAP fault (HTTP %d)" % status))
    if status >= 400:
        raise OnvifError("HTTP %d from %s" % (status, url))
    return root


# ── ONVIF Profile S operations ──────────────────────────────────────

def get_clock_skew(xaddr, post=None):
    """Device UTC − local UTC, via anonymous GetSystemDateAndTime (best-effort).

    ONVIF digest auth is time-sensitive (±5 s window on many cameras); the skew
    is applied to the WS-UsernameToken Created stamp of every later call.
    """
    body = '<tds:GetSystemDateAndTime xmlns:tds="%s"/>' % NS_DEVICE
    try:
        root = soap_call(xaddr, body, post=post)
    except OnvifError:
        return 0.0
    utc = root.find(".//{*}UTCDateTime")
    if utc is None:
        return 0.0
    try:
        t = utc.find(".//{*}Time")
        d = utc.find(".//{*}Date")
        device = datetime.datetime(
            int(_text(d.find("{*}Year"))),
            int(_text(d.find("{*}Month"))),
            int(_text(d.find("{*}Day"))),
            int(_text(t.find("{*}Hour"))),
            int(_text(t.find("{*}Minute"))),
            int(_text(t.find("{*}Second"))),
            tzinfo=datetime.timezone.utc,
        )
    except (AttributeError, TypeError, ValueError):
        return 0.0
    return device.timestamp() - time.time()


def get_device_information(xaddr, creds, post=None, skew=0.0):
    body = '<tds:GetDeviceInformation xmlns:tds="%s"/>' % NS_DEVICE
    root = soap_call(xaddr, body, creds=creds, post=post, skew=skew)
    return {
        "manufacturer": _text(root.find(".//{*}Manufacturer")),
        "model": _text(root.find(".//{*}Model")),
        "serial": _text(root.find(".//{*}SerialNumber")),
        "firmware": _text(root.find(".//{*}FirmwareVersion")),
    }


def get_media_xaddr(xaddr, creds, post=None, skew=0.0):
    """Media service URL via GetCapabilities (fallback: the device XAddr)."""
    body = (
        '<tds:GetCapabilities xmlns:tds="%s" xmlns:tt="%s">'
        "<tds:Category>Media</tds:Category></tds:GetCapabilities>"
    ) % (NS_DEVICE, NS_SCHEMA)
    try:
        root = soap_call(xaddr, body, creds=creds, post=post, skew=skew)
    except OnvifAuthError:
        raise
    except OnvifError:
        return xaddr
    media = root.find(".//{*}Media")
    if media is None:
        return xaddr
    return _text(media.find(".//{*}XAddr")) or xaddr


def get_profiles(media_xaddr, creds, post=None, skew=0.0):
    """Media profiles → [{token, name, width, height}], as listed by the device."""
    body = '<trt:GetProfiles xmlns:trt="%s"/>' % NS_MEDIA
    root = soap_call(media_xaddr, body, creds=creds, post=post, skew=skew)
    profiles = []
    for prof in root.iter():
        if not prof.tag.endswith("}Profiles"):
            continue
        token = prof.get("token", "")
        if not token:
            continue
        name = ""
        for child in prof:
            if child.tag.endswith("}Name"):
                name = _text(child)
                break
        width = height = 0
        venc = None
        for child in prof:
            if child.tag.endswith("}VideoEncoderConfiguration"):
                venc = child
                break
        if venc is not None:
            res = venc.find(".//{*}Resolution")
            if res is not None:
                width = as_int(_text(res.find("{*}Width")))
                height = as_int(_text(res.find("{*}Height")))
        profiles.append({"token": token, "name": name, "width": width, "height": height})
    return profiles


def get_stream_uri(media_xaddr, profile_token, creds, post=None, skew=0.0):
    body = (
        '<trt:GetStreamUri xmlns:trt="{m}" xmlns:tt="{t}">'
        "<trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream>"
        "<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>"
        "</trt:StreamSetup><trt:ProfileToken>{tok}</trt:ProfileToken>"
        "</trt:GetStreamUri>"
    ).format(m=NS_MEDIA, t=NS_SCHEMA, tok=xml_escape(profile_token))
    root = soap_call(media_xaddr, body, creds=creds, post=post, skew=skew)
    return _text(root.find(".//{*}Uri"))


# ── Credentials, RTSP URIs, camera identity ─────────────────────────

def find_camera_override(onvif_cfg, device):
    """The `onvif.cameras` entry whose `match` equals the device's IP,
    serial number or MAC (case-insensitive). None when there is no entry."""
    keys = {
        str(device.get("ip", "")).lower(),
        str(device.get("serial", "")).lower(),
        str(device.get("mac", "")).lower().replace("-", ":"),
    }
    keys.discard("")
    for entry in onvif_cfg.get("cameras", []):
        match = str(entry.get("match", "")).lower().replace("-", ":")
        if match and match in keys:
            return entry
    return None


def credential_candidates(onvif_cfg, device):
    """Credential try-list: the per-camera entry first, then the defaults,
    then anonymous (None) as a last resort."""
    candidates = []
    override = find_camera_override(onvif_cfg, device)
    if override and override.get("user"):
        candidates.append((override.get("user", ""), override.get("password", "")))
    candidates.extend(onvif_cfg.get("default_credentials", []))
    candidates.append(None)
    # dedupe, preserving order
    seen, out = set(), []
    for cand in candidates:
        if cand in seen:
            continue
        seen.add(cand)
        out.append(cand)
    return out


def embed_credentials(rtsp_uri, user, password):
    """rtsp://host/path → rtsp://user:pass@host/path (userinfo URL-encoded)."""
    if not user:
        return rtsp_uri
    parts = urllib.parse.urlsplit(rtsp_uri)
    host = parts.hostname or ""
    if ":" in host:  # IPv6 literal
        host = "[%s]" % host
    userinfo = urllib.parse.quote(user, safe="") + ":" + urllib.parse.quote(
        password or "", safe=""
    )
    netloc = userinfo + "@" + host
    if parts.port:
        netloc += ":%d" % parts.port
    return urllib.parse.urlunsplit(
        (parts.scheme, netloc, parts.path, parts.query, parts.fragment)
    )


def select_streams(profiles):
    """(main, sub) profiles: main = highest resolution, sub = lowest.

    With a single profile both point at it; with none, both are None.
    """
    with_res = [p for p in profiles if p.get("width")]
    ordered = sorted(with_res or profiles, key=lambda p: p.get("width", 0), reverse=True)
    if not ordered:
        return None, None
    return ordered[0], ordered[-1]


def camera_key(camera):
    """Stable identity for the state file: serial → MAC → endpoint → IP."""
    for field in ("serial", "mac", "epr", "ip"):
        val = str(camera.get(field, "")).strip()
        if val:
            return val
    return ""


def room_for(camera):
    """Deterministic StreamHub room: onvif-<slug(key)> (API prefixes the app)."""
    slug = re.sub(r"[^a-z0-9._-]+", "-", camera_key(camera).lower()).strip("-.")
    return ("onvif-" + slug)[:64].rstrip("-.")


# ── Device interrogation ────────────────────────────────────────────

def interrogate(device, onvif_cfg, post=None):
    """Turn a discovered device into a full camera dict (or error record):

    {key, name, model, manufacturer, serial, mac, ip, xaddr, user, profiles:
     [{token,name,width,height,rtsp}], main_rtsp, sub_rtsp} — RTSP URIs carry
    the working credentials inline (StreamHub URL-pull needs them in the URI).
    """
    xaddr = pick_xaddr(device["xaddrs"])
    cam = {
        "key": "",
        "name": device.get("name") or "",
        "hardware": device.get("hardware") or "",
        "model": "",
        "manufacturer": "",
        "serial": "",
        "mac": device.get("mac") or "",
        "ip": device.get("ip") or "",
        "epr": device.get("epr") or "",
        "xaddr": xaddr,
        "user": "",
        "profiles": [],
        "main_rtsp": "",
        "sub_rtsp": "",
        "error": "",
    }

    skew = get_clock_skew(xaddr, post=post)

    creds = None
    info = None
    last_err = "no credentials worked"
    for cand in credential_candidates(onvif_cfg, {**device, **cam}):
        try:
            info = get_device_information(
                xaddr, creds=cand, post=post, skew=skew
            )
            creds = cand
            break
        except OnvifAuthError as err:
            last_err = str(err) or "not authorized"
        except OnvifError as err:
            cam["key"] = camera_key(cam)
            cam["error"] = "device error: %s" % err
            return cam
    if info is None:
        cam["key"] = camera_key(cam)
        cam["error"] = "auth failed (%s) — add credentials under onvif.cameras" % last_err
        return cam

    cam["model"] = info["model"]
    cam["manufacturer"] = info["manufacturer"]
    cam["serial"] = info["serial"]
    if not cam["name"]:
        cam["name"] = (info["manufacturer"] + " " + info["model"]).strip() or cam["ip"]
    cam["user"] = creds[0] if creds else ""

    try:
        media = get_media_xaddr(xaddr, creds=creds, post=post, skew=skew)
        profiles = get_profiles(media, creds=creds, post=post, skew=skew)
        for prof in profiles:
            uri = get_stream_uri(media, prof["token"], creds=creds, post=post, skew=skew)
            if uri and creds:
                uri = embed_credentials(uri, creds[0], creds[1])
            prof["rtsp"] = uri
        cam["profiles"] = profiles
        main, sub = select_streams([p for p in profiles if p.get("rtsp")])
        cam["main_rtsp"] = main["rtsp"] if main else ""
        cam["sub_rtsp"] = sub["rtsp"] if sub else ""
    except OnvifError as err:
        cam["error"] = "media error: %s" % err

    cam["key"] = camera_key(cam)
    return cam


def scan(settings, post=None, discover_fn=None):
    """Discover + interrogate every ONVIF device on the LAN."""
    discover_fn = discover_fn or discover
    devices = discover_fn(
        timeout=settings.get("discovery_timeout", WS_DISCOVERY_TIMEOUT),
        bind=settings.get("bind", ""),
    )
    return [interrogate(dev, settings, post=post) for dev in devices]


# ── Local state (idempotent sync) ───────────────────────────────────

def load_state(path):
    if not os.path.isfile(path):
        return {"version": STATE_VERSION, "cameras": {}}
    try:
        with open(path, "r", encoding="utf-8") as f:
            state = json.load(f)
    except (json.JSONDecodeError, OSError):
        return {"version": STATE_VERSION, "cameras": {}}
    if not isinstance(state.get("cameras"), dict):
        state["cameras"] = {}
    state["version"] = STATE_VERSION
    return state


def save_state(path, state):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, sort_keys=True)
        f.write("\n")
    if os.name == "nt" and os.path.exists(path):
        os.remove(path)
    os.replace(tmp, path)


def registration_for(camera, settings):
    """(mode, rtsp) this camera should be registered with. Per-camera
    `onvif.cameras` overrides (`mode:`, `stream:`) win over the globals."""
    override = find_camera_override(settings, camera) or {}
    mode = str(override.get("mode") or settings.get("register_mode", "url")).strip()
    stream = str(override.get("stream") or settings.get("prefer_stream", "main")).strip()
    rtsp = camera.get("sub_rtsp") if stream == "sub" else camera.get("main_rtsp")
    return (mode if mode in ("url", "passthrough") else "url"), (rtsp or "")


def plan_sync(cameras, state, settings):
    """Diff discovered cameras against the state file → list of actions.

    Returns [(action, camera, entry)] with action ∈ register | update | keep |
    skip | missing. Pure — no I/O — so re-run behaviour is testable:
      register  new camera (or previous registration attempt failed)
      update    same camera, but its RTSP URI or mode changed
      keep      already registered, nothing changed
      skip      camera has no usable RTSP URI (auth/media error)
      missing   in the state file but NOT discovered this run (reported only)
    """
    actions = []
    seen = set()
    for cam in cameras:
        key = cam.get("key") or camera_key(cam)
        seen.add(key)
        mode, rtsp = registration_for(cam, settings)
        entry = state["cameras"].get(key)
        if cam.get("error") and not rtsp:
            actions.append(("skip", cam, entry))
            continue
        if not entry or not entry.get("ingress_id"):
            actions.append(("register", cam, entry))
        elif entry.get("rtsp") != rtsp or entry.get("mode") != mode:
            actions.append(("update", cam, entry))
        else:
            actions.append(("keep", cam, entry))
    for key, entry in sorted(state["cameras"].items()):
        if key not in seen:
            actions.append(("missing", None, entry))
    return actions


# ── StreamHub registration ──────────────────────────────────────────

def build_ingress_payload(camera, mode, rtsp):
    """POST /apps/<app>/ingress body (field names per StreamHub's
    CreateIngressDto): url-pull on the transcode plane by default;
    {inputType:'rtmp', mode:'passthrough'} for the HLS-wall plane."""
    room = room_for(camera)
    if mode == "passthrough":
        return {
            "inputType": "rtmp",
            "mode": "passthrough",
            "room": room,
            "participantName": camera.get("name") or room,
        }
    return {
        "inputType": "url",
        "url": rtsp,
        "room": room,
        "participantName": camera.get("name") or room,
    }


class StreamHubApi:
    """Thin client for the two ingress calls sync needs. `post` is injectable
    (tests never touch the network)."""

    def __init__(self, base_url, app, token, post=None, insecure=False):
        self.base_url = base_url.rstrip("/")
        self.app = app
        self.token = token
        self.post = post or default_http_post
        self.insecure = insecure

    def _headers(self):
        return {
            "Authorization": "Bearer " + self.token,
            "Content-Type": "application/json",
        }

    def create_ingress(self, payload):
        url = "%s/apps/%s/ingress" % (self.base_url, self.app)
        status, body = self.post(
            url, json.dumps(payload).encode(), self._headers(), insecure=self.insecure
        )
        try:
            data = json.loads(body or b"{}")
        except json.JSONDecodeError:
            data = {}
        if status < 200 or status >= 300:
            fallback = body.decode(errors="replace")[:300] if body else str(status)
            message = str(data.get("message", fallback)) if isinstance(data, dict) else fallback
            if "private" in message or "loopback" in message:
                message += (
                    " — StreamHub's SSRF guard rejects private RTSP pull URLs. "
                    "If this StreamHub cannot reach the camera LAN, register the "
                    "camera with `mode: passthrough` instead (the agent pushes "
                    "RTMP to StreamHub; see the ONVIF section of the README)."
                )
            raise RuntimeError("ingress create failed (HTTP %d): %s" % (status, message))
        return data.get("data", data)

    def delete_ingress(self, ingress_id):
        url = "%s/apps/%s/ingress/%s" % (
            self.base_url,
            self.app,
            urllib.parse.quote(str(ingress_id), safe=""),
        )
        status, _body = self.post(
            url, b"", self._headers(), insecure=self.insecure, method="DELETE"
        )
        return 200 <= status < 300 or status == 404


def entry_from(camera, mode, rtsp, data):
    """State-file entry for a registered camera."""
    now = int(time.time())
    return {
        "name": camera.get("name", ""),
        "model": camera.get("model", ""),
        "ip": camera.get("ip", ""),
        "serial": camera.get("serial", ""),
        "mac": camera.get("mac", ""),
        "mode": mode,
        "rtsp": rtsp,
        "room": room_for(camera),
        "ingress_id": str(data.get("ingressId", "")),
        "stream_key": str(data.get("streamKey") or data.get("stream_key") or ""),
        "rtmp_url": str(data.get("rtmp_url") or ""),
        "hls_url": str(data.get("hls_url") or ""),
        "player_url": str(data.get("player_url") or ""),
        "registered_at": now,
        "last_seen": now,
        "missing_since": None,
    }


def sync(settings, post=None, discover_fn=None, api=None, out=print, dry_run=False):
    """scan + register: the idempotent `onvif sync` core. Returns (state,
    summary) where summary counts each action."""
    cameras = scan(settings, post=post, discover_fn=discover_fn)
    state = load_state(settings["state_file"])
    actions = plan_sync(cameras, state, settings)

    if api is None and not dry_run:
        if not settings["base_url"] or not settings["app"]:
            raise RuntimeError(
                "agent.callback_url / agent.tenant missing in config.yml — "
                "cannot register cameras"
            )
        if not settings["token"]:
            raise RuntimeError(
                "no sk_ API token in secrets.ini [streamhub] — cannot register"
            )
        api = StreamHubApi(
            settings["base_url"], settings["app"], settings["token"],
            insecure=settings.get("insecure", False),
        )

    summary = {"register": 0, "update": 0, "keep": 0, "skip": 0, "missing": 0, "error": 0}
    now = int(time.time())
    for action, cam, entry in actions:
        if action == "missing":
            summary["missing"] += 1
            if not entry.get("missing_since"):
                entry["missing_since"] = now
            out(
                "MISSING  %s (%s) — last seen %s; ingress %s kept (not auto-deleted)"
                % (
                    entry.get("name", "?"),
                    entry.get("ip", "?"),
                    time.strftime("%Y-%m-%d %H:%M", time.localtime(entry.get("last_seen", 0))),
                    entry.get("ingress_id", "?"),
                )
            )
            continue

        key = cam.get("key")
        mode, rtsp = registration_for(cam, settings)

        if action == "skip":
            summary["skip"] += 1
            out("SKIP     %s (%s): %s" % (cam.get("name") or key, cam.get("ip"), cam.get("error")))
            continue
        if action == "keep":
            summary["keep"] += 1
            entry["last_seen"] = now
            entry["missing_since"] = None
            out("OK       %s (%s) → ingress %s [%s]" % (
                cam.get("name") or key, cam.get("ip"), entry.get("ingress_id"), mode))
            continue

        verb = "REGISTER" if action == "register" else "UPDATE"
        if dry_run:
            summary[action] += 1
            out("%-8s %s (%s) [%s] (dry-run)" % (verb, cam.get("name") or key, cam.get("ip"), mode))
            continue
        try:
            if action == "update" and entry and entry.get("ingress_id"):
                api.delete_ingress(entry["ingress_id"])
            data = api.create_ingress(build_ingress_payload(cam, mode, rtsp))
            state["cameras"][key] = entry_from(cam, mode, rtsp, data)
            summary[action] += 1
            extra = ""
            if mode == "passthrough" and state["cameras"][key]["rtmp_url"]:
                extra = " push→ %s" % state["cameras"][key]["rtmp_url"]
            out("%-8s %s (%s) → ingress %s [%s]%s" % (
                verb, cam.get("name") or key, cam.get("ip"),
                state["cameras"][key]["ingress_id"], mode, extra))
        except (RuntimeError, OSError) as err:
            summary["error"] += 1
            out("ERROR    %s (%s): %s" % (cam.get("name") or key, cam.get("ip"), err))

    if not dry_run:
        save_state(settings["state_file"], state)
    return state, summary


# ── Output ──────────────────────────────────────────────────────────

def format_table(headers, rows):
    """Plain fixed-width table (no external deps)."""
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(str(cell)))
    fmt = "  ".join("%%-%ds" % w for w in widths)
    lines = [fmt % tuple(headers), fmt % tuple("-" * w for w in widths)]
    lines.extend(fmt % tuple(str(c) for c in row) for row in rows)
    return "\n".join(lines)


def scan_table(cameras, state):
    rows = []
    for cam in cameras:
        entry = state["cameras"].get(cam.get("key", ""), {})
        registered = "-"
        if entry.get("ingress_id"):
            registered = "%s [%s]" % (entry["ingress_id"], entry.get("mode", "?"))
        if cam.get("error"):
            main = cam.get("main_rtsp") or ("! " + cam["error"])
        else:
            main = cam.get("main_rtsp") or "-"
        sub = cam.get("sub_rtsp") or "-"
        if sub == main:
            sub = "="
        rows.append([
            cam.get("name") or "?",
            cam.get("model") or cam.get("hardware") or "?",
            cam.get("ip") or "?",
            cam.get("serial") or cam.get("mac") or "?",
            main,
            sub,
            registered,
        ])
    return format_table(
        ["NAME", "MODEL", "IP", "SERIAL/MAC", "MAIN RTSP", "SUB RTSP", "REGISTERED"],
        rows,
    )


# ── CLI ─────────────────────────────────────────────────────────────

def build_arg_parser():
    parser = argparse.ArgumentParser(
        prog="streamhub-agent onvif",
        description="ONVIF camera discovery + StreamHub auto-registration",
    )
    parser.add_argument("command", choices=["scan", "sync"],
                        help="scan: discover + print; sync: scan + register")
    parser.add_argument("--config", default="config.yml",
                        help="agent config.yml (default: config.yml)")
    parser.add_argument("--secrets", default="secrets.ini",
                        help="agent secrets.ini (default: secrets.ini)")
    parser.add_argument("--timeout", type=int, default=0,
                        help="WS-Discovery listen seconds (overrides config)")
    parser.add_argument("--state", default="",
                        help="state file path (overrides onvif.state_file)")
    parser.add_argument("--json", action="store_true",
                        help="print machine-readable JSON instead of a table")
    parser.add_argument("--dry-run", action="store_true",
                        help="sync: print the plan, register nothing")
    parser.add_argument("--insecure", action="store_true",
                        help="skip TLS verification talking to StreamHub")
    parser.add_argument("--quiet", action="store_true",
                        help="only errors and the summary line")
    return parser


def main(argv=None):
    args = build_arg_parser().parse_args(argv)
    try:
        settings = load_config(args.config, args.secrets)
    except OSError as err:
        print("onvif: cannot read config: %s" % err, file=sys.stderr)
        return 1
    if args.timeout > 0:
        settings["discovery_timeout"] = args.timeout
    if args.state:
        settings["state_file"] = args.state
    settings["insecure"] = args.insecure

    out = (lambda *_a, **_k: None) if args.quiet else print

    if args.command == "scan":
        out("onvif: probing the LAN (WS-Discovery, %ds) ..." % settings["discovery_timeout"])
        cameras = scan(settings)
        state = load_state(settings["state_file"])
        if args.json:
            print(json.dumps({"cameras": cameras}, indent=2))
        else:
            if not cameras:
                print("onvif: no ONVIF cameras answered the probe")
                return 0
            print(scan_table(cameras, state))
        return 0

    # sync
    try:
        state, summary = sync(settings, out=out, dry_run=args.dry_run)
    except RuntimeError as err:
        print("onvif: %s" % err, file=sys.stderr)
        return 1
    line = (
        "onvif sync: %(register)d registered, %(update)d updated, %(keep)d up-to-date, "
        "%(skip)d skipped, %(missing)d missing, %(error)d errors" % summary
    )
    if args.json:
        print(json.dumps({"summary": summary, "cameras": state["cameras"]}, indent=2))
    else:
        print(line)
    return 1 if summary["error"] else 0


if __name__ == "__main__":
    sys.exit(main())
