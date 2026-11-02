# DRM — encrypted VOD/HLS packaging (`features.drm`)

## What it does

Optionally packages an app's **VOD/HLS output** with common encryption
(CENC/CBCS CMAF) instead of clear HLS, so recordings can be delivered under
Widevine / PlayReady / FairPlay. It is **off by default** — with `features.drm`
absent or `enabled: false` the VOD pipeline is byte-for-byte the clear
[adaptive-VOD](adaptive-vod.md) path, unchanged.

Scope is deliberately narrow:

- **Only the packaged VOD/HLS output** is protected. Live **WebRTC** playback is
  already encrypted on the wire by SRTP and never passes through a CDM, so it is
  out of scope. Live HLS is out of scope for this first cut.
- **No vendor keys ship in this repo.** StreamHub does not mint content keys
  itself; it calls an operator-configured **external key server** (SPEKE-style).
  Until one is configured and the `shaka-packager` binary is present, every
  packaging decision is `clear` (or, when DRM is explicitly enabled, a loud
  fail-closed `skip`). See "Wiring a real key server" below.

## Pipeline

ffmpeg cannot emit CENC/CBCS common-encryption fMP4 — that is `shaka-packager`
territory. So the DRM path replaces the clear HLS ladder with:

```
VOD ready ──► job transcode (in-process transcode queue), per recording:
   ├─ DrmService.decide(cfg, base) → clear | skip | clear-degraded | encrypt
   └─ encrypt:
        ├─ ffmpeg: one mezzanine MP4 per rendition (scale + H.264/AAC, faststart)
        ├─ shaka-packager: ONE run over the ladder → CMAF HLS (CENC/CBCS),
        │    clear_lead 0, shared audio group, master.m3u8
        ├─ upload the flat tree under the SAME hls/<base>/ prefix
        ├─ vod_variants rows: master `hls-drm` + rendition `hls-cmaf-<scheme>`
        │    (PUBLIC metadata only — scheme/systems/keyIds/licenseUrls;
        │     content-key VALUES never persisted)
        ├─ metatags: hlsMasterKey + drm summary
        └─ callback vod_variants_ready (carries the drm summary)
```

While DRM is **enforced** (an `encrypt` or fail-closed `skip` decision) no clear
variant may ship, so the WebM/VP8 alternate is suppressed too (it has no DRM
path).

### The decision (guard chain)

`DrmService.decide()` returns one of four modes; `VodTranscodeService` branches
on that single value:

| `features.drm` state | Decision | Effect |
|---|---|---|
| `enabled: false` (default) | `clear` | Clear packaging, pipeline unchanged. |
| enabled, but provider unconfigured / no `shaka-packager` / key server returns nothing, and `fail_open: false` (default) | `skip` | **Fail closed** — NO HLS variants ship; `drmError` recorded; base MP4 VOD untouched. |
| same, but `fail_open: true` | `clear-degraded` | Degrade to clear packaging, logged loudly. |
| enabled + provider ready + packager present + keys available | `encrypt` | Encrypt with the provider's content keys. |

The chain never throws and never puts secrets in a reason string or log.

## Config (per-app `config.yaml`)

```yaml
features:
  drm:
    enabled: false                 # master switch (default false = clear packaging)
    provider: none                 # none (noop, default) | external (key server)
    systems: [widevine, playready, fairplay]   # systems to signal/protect for
    scheme: cbcs                   # cbcs (default, CMAF one-encode) | cenc
    key_server_url: ""             # SPEKE-style POST endpoint (empty = unconfigured)
    key_server_token_env: ""       # "" = no token; else exactly APP_<SLUG>_DRM_TOKEN
    license_urls:                  # per-system license servers handed to players
      widevine: ""
      playready: ""
      fairplay: ""
    fairplay_cert_url: ""          # FairPlay application certificate URL (Safari)
    fail_open: false               # false = fail CLOSED (skip); true = degrade to clear
```

Every field is resolved with a default by `ResolveDrmFeatures`
(`streamhub-core-go/internal/recording/drm.go`): garbage input degrades to the safe
values (disabled, noop, cbcs, fail-closed). `enabled`/`fail_open` are **strict
booleans** (only `true` enables); unknown `provider`→`none`, unknown
`scheme`→`cbcs`; unknown `systems` entries are dropped and an empty list falls
back to all three. Written back to the YAML sanitized through the same resolver,
so garbage never lands on disk.

- **`scheme`** — `cbcs` (AES-CBC pattern) is the one-encode-covers-all choice:
  required by FairPlay, played by modern Widevine + PlayReady. `cenc` (AES-CTR)
  has the widest legacy Widevine/PlayReady device reach but is **not** playable
  by FairPlay/Safari.
- **`key_server_token_env`** is a **reference name** (like the S3 `*_env`
  fields), never the token value. Since 3.3.3 the name is **server-derived**:
  empty means "no bearer token"; otherwise it must be exactly
  `APP_<SLUG>_DRM_TOKEN` (any other value → 400 on the raw editor and on
  `PATCH /apps/{app}/config`), and the token is read from that
  `data/secrets.json` key at packaging time — never from an arbitrary env var.

## The provider seam

`DrmProvider` (`internal/recording/drm.go`) is the pluggable
content-key seam. Two implementations ship:

- **`NoopDrmProvider`** (default) — DRM off / unconfigured. Never `ready()`,
  returns no keys, contributes no packaging args → the pipeline stays clear.
- **`ExternalDrmProvider`** (same file) — a SPEKE-style
  multi-DRM key-server **client stub**. It POSTs `{ asset_id, systems, scheme }`
  (bearer token from `key_server_token_env`) to `key_server_url` and expects:

  ```json
  { "keys": [{ "key_id": "<32-hex>", "key": "<32-hex>", "iv": "<32-hex>?" }],
    "pssh": [{ "system": "widevine", "box": "<base64>" }],
    "hls_key_uri": "skd://..." }
  ```

  Responses are normalized (snake/camel key ids, `0x`/UUID/uppercase hex all
  accepted; invalid keys dropped; unknown `systems` dropped). **Any** failure
  (network, non-2xx, malformed body, bad hex, all-invalid keys) degrades to
  `null` and the `DrmService` decides fail-open vs fail-closed. Adding a vendor
  (EZDRM, Axinom, BuyDRM, PallyCon, DRMtoday, …) = one new class here; nothing
  else in the pipeline changes.

The provider's `packagingArgs()` builds the extra `shaka-packager` argv
(`--enable_raw_key_encryption --protection_scheme <cbcs|cenc> --clear_lead 0
--keys …` plus `--pssh` / `--hls_key_uri` when supplied).

## Wiring a real key server

1. Install `shaka-packager` in the core image (or set `SHAKA_PACKAGER_BIN` to
   its path). The whole DRM path is a no-op when the binary is absent.
2. Set the app's `features.drm`: `enabled: true`, `provider: external`,
   `key_server_url`, `key_server_token_env: APP_<SLUG>_DRM_TOKEN` (store the
   token in `data/secrets.json` under that key), and the per-system `license_urls`.
3. **The integration point is `ExternalDrmProvider.GetContentKeys()`
   (`streamhub-core-go/internal/recording/drm.go`)** — the one method that
   talks to the key server. A vendor that speaks true SPEKE/CPIX XML gets its
   own subclass/adapter here; select it in `DrmService.providerFor()`
   (`streamhub-core-go/internal/recording/drm.go`). The clear packaging fallback and
   the fail-open/closed policy live entirely in `DrmService`, so a new provider
   only implements key fetching.

## Security

- **Content-key VALUES never leave the provider/packager boundary.** They are
  never logged, never persisted to the DB, never serialized into `vod_variants`
  rows, metatags, or callbacks — only public `keyId`s and `licenseUrls` are
  surfaced. The DRM unit + integration specs assert the secret never appears in
  any row/metatag/callback payload.
- Raw-key mode passes `key=<hex>` on the packager argv, which is visible in the
  container's process list while packaging runs — an accepted trade-off of
  shaka's raw-key CLI (a production deployment can use provider-integrated
  key-server signing instead). The args are never logged.

## Callbacks

- `vod_variants_ready` — when DRM encrypts, the payload carries a `drm` summary
  `{ scheme, systems, keyIds, licenseUrls, hlsKeyUri? }` alongside the usual
  `masterKey` / `variants[]`. `webmKey` is `null` (suppressed under DRM).

## Variant rows (`vod_variants`)

| kind | format | Notes |
|---|---|---|
| `master` | `hls-drm` | `file_key` = `hls/<base>/master.m3u8`; `extra_json` carries the PUBLIC drm summary + audio keys. |
| `rendition` | `hls-cmaf-<scheme>` | one per height; `extra_json.drm: true` + the CMAF segment key for the delete cascade. |

The `DELETE /vods/:id` cascade removes these objects like any other variant.

## Known limitations / next steps

- **HLS live** is not encrypted — DRM applies to VOD packaging only.
- **Raw-key mode only.** Provider-integrated modes (Widevine key-server signing,
  true SPEKE/CPIX) are the natural next step; the seam is ready for them.
- **No player-side license wiring yet.** The `licenseUrls` / `fairplayCertUrl`
  are surfaced to players via the master variant metadata, but the dashboard
  player does not yet request licenses — bring your own CDM-enabled player.
- **No retroactive re-package** of clear VODs into DRM (new recordings only).
