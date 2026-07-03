# Tokens: API tokens + LiveKit join tokens

Two distinct token concepts:

1. **API tokens** (`sk_...`) — long-lived Bearer credentials for automation /
   server-to-server. Managed under `/tokens`.
2. **LiveKit join tokens** — short-lived tokens a client uses to connect to a
   room (publish/subscribe). Minted per app under `/apps/:app/tokens`, with
   grants like hidden QC, recorder, audioOnly.

---

## 1. API tokens (`sk_`)

### What it does
Bearer tokens stored **hashed** (sha256); plaintext is shown **once** at
creation. Scope is `global` (superadmin-ish, no app binding) or `app` (bound to
one app, inherits that app's tenant). Optional per-token **IP whitelist** (exact
IPv4 or CIDR, honoring `X-Forwarded-For`). Tokens can be revoked (soft-delete).
Prefix is `sk_` + 32 random bytes base64url.

### Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/tokens` | Bearer | List tokens (hashes never returned) |
| POST | `/tokens` | Bearer | Create a token (plaintext returned once) |
| DELETE | `/tokens/:id` | Bearer | Revoke (soft-delete), 204 |

#### POST /tokens — body

```json
{ "name": "ui-server", "scope": "global", "appId": 3, "allowedIps": ["127.0.0.1", "10.0.0.0/8"] }
```

- `scope` ∈ {global, app}. `appId` **required** when `scope=app`, forbidden otherwise.
- `allowedIps` optional; empty/absent = no restriction.

#### Response

```json
// POST 201
{ "id": 5, "token": "sk_AbC..." }         // plaintext — store it now
// GET 200 (summary)
[ { "id": 5, "name": "ui-server", "scope": "app", "appId": 3,
    "lastUsedAt": "2026-06-30T12:00:00Z", "createdAt": "...", "revoked": false } ]
```

### Example
```bash
curl -s -X POST $BASE/tokens -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"ci","scope":"app","appId":3,"allowedIps":["203.0.113.10"]}'
```

---

## 2. LiveKit join tokens

### What it does
`POST /apps/:app/tokens` mints a LiveKit access token for a room of the app and
returns it together with the public player/embed URLs. Supports the full grant
matrix and the wave-2 features:

- **publish/subscribe** grants (`canPublish`, `canSubscribe`).
- **hidden QC** (`hidden:true`) — subscribes to all media but is invisible and
  **not counted as a viewer**; gated by the app `hiddenQc` feature flag. Ideal
  for monitoring/QC and the recorder.
- **recorder** (`recorder:true`) — roomRecord grant; subscribe-only by default
  so it never affects the stream. Pairs with `hidden`.
- **audioOnly** (`audioOnly:true`) — restricts publishing to the microphone
  (no camera/screenshare); used by voice rooms and radio.
- **adaptive** — when the app's `adaptivePlayer` flag is on, the simulcast
  ladder is injected into the token metadata (`streamhub.simulcast`).

Minting a **publisher** token (`canPublish !== false`) counts against the tenant
`max_concurrent_streams` quota; subscribe-only tokens do not.

### Endpoint

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| POST | `/apps/:app/tokens` | stream:write | Mint a join token (+ player/embed URLs) |
| GET | `/apps/:app/radio/:room/listen-token` | public | Subscribe-only audio token (radio, see radio-audio.md) |

#### POST /apps/:app/tokens — body (all optional)

```json
{
  "room": "demo",
  "identity": "user-123",
  "name": "Alice",
  "canPublish": true,
  "canSubscribe": true,
  "ttl": "6h",
  "metadata": "{...}",
  "hidden": false,
  "recorder": false,
  "audioOnly": false
}
```

- `room` defaults to the app prefix; namespaced if not already prefixed.
- `identity` defaults to a random id. `ttl` default `6h`.
- `hidden` only takes effect if the app enables `hiddenQc`.

#### Response

```json
{ "data": {
  "token": "<livekit-jwt>",
  "app": "demo",
  "room": "demo",
  "identity": "user-123",
  "hidden": false,
  "audioOnly": false,
  "adaptive": true,
  "wsUrl": "wss://media.example.com",
  "playUrl": "https://streamhub.example.com/play/demo/demo",
  "embedUrl": "https://streamhub.example.com/embed/demo/demo",
  "iframe": "<iframe src=\"...\" ...></iframe>"
} }
```

### Examples

```bash
# publisher token
curl -s -X POST $BASE/apps/demo/tokens -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"room":"demo","identity":"alice","canPublish":true}'

# hidden QC / recorder token (subscribe-only, invisible)
curl -s -X POST $BASE/apps/demo/tokens -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"room":"demo","identity":"qc","hidden":true,"recorder":true}'

# audio-only publisher (voice room)
curl -s -X POST $BASE/apps/demo/tokens -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"room":"voice","identity":"alice","audioOnly":true}'
```

## Notes

- The `wsUrl` is the **public** LiveKit WSS (`PUBLIC_WS_URL`), not the internal
  `ws://127.0.0.1:7880`. Clients connect there.
- Player URLs use `PUBLIC_BASE_URL` when configured, else relative paths.
- Hidden/recorder participants are excluded from webhook stream rows and the
  viewer count (see chat-reactions-viewers.md).
</content>
